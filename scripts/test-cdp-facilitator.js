// Pins src/cdp-facilitator.js, the CDP facilitator config that replaced
// @coinbase/x402's createFacilitatorConfig: the URL, the four header groups
// @x402/core's HTTPFacilitatorClient reads, the Correlation-Context string,
// and per-path JWTs whose header and claims match the SDK's generateJwt and
// whose signatures verify, for both CDP key formats, minted fresh on every
// call, and the same on the wire for supported, verify and settle through
// @x402/core's client. Also pins that the server reaches it (not the
// removed package) and that the package is gone from package.json. Offline.
//   node scripts/test-cdp-facilitator.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync, verify as edVerify, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { cdpFacilitatorConfig, cdpCorrelationHeader, CDP_FACILITATOR_URL } from "../src/cdp-facilitator.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());

ok(CDP_FACILITATOR_URL === "https://api.cdp.coinbase.com/platform/v2/x402", "facilitator URL");
ok(cdpCorrelationHeader() === "sdk_version=1.29.0,sdk_language=typescript,source=x402,source_version=2.1.0", "Correlation-Context string");

const ed = generateKeyPairSync("ed25519");
const jwk = ed.privateKey.export({ format: "jwk" });
const edSecret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecSecret = ec.privateKey.export({ type: "pkcs8", format: "pem" });

const PATHS = { verify: "POST", settle: "POST", supported: "GET" };
for (const [label, secret, alg, check] of [
  ["Ed25519", edSecret, "EdDSA", (input, sig) => edVerify(null, Buffer.from(input), ed.publicKey, sig)],
  ["EC P-256", ecSecret, "ES256", (input, sig) => createVerify("SHA256").update(input).verify({ key: ec.publicKey, dsaEncoding: "ieee-p1363" }, sig)],
]) {
  const cfg = cdpFacilitatorConfig("kid-1", secret);
  ok(cfg.url === CDP_FACILITATOR_URL, `${label}: config url`);
  const h = await cfg.createAuthHeaders();
  ok(JSON.stringify(Object.keys(h)) === '["verify","settle","supported","list"]', `${label}: header groups verify, settle, supported, list`);
  for (const k of Object.keys(h)) ok(h[k]["Correlation-Context"] === cdpCorrelationHeader(), `${label}: ${k} carries Correlation-Context`);
  ok(!("Authorization" in h.list), `${label}: list carries no Authorization (as the package)`);
  const nonces = new Set();
  for (const [path, method] of Object.entries(PATHS)) {
    const auth = h[path].Authorization || "";
    ok(auth.startsWith("Bearer "), `${label}: ${path} has a Bearer token`);
    const jwt = auth.slice(7);
    const head = part(jwt, 0), claims = part(jwt, 1);
    ok(JSON.stringify(Object.keys(head)) === '["alg","kid","typ","nonce"]' && head.alg === alg && head.kid === "kid-1" && head.typ === "JWT", `${label}: ${path} JWT header`);
    nonces.add(head.nonce);
    ok(JSON.stringify(Object.keys(claims)) === '["sub","iss","uris","iat","nbf","exp"]', `${label}: ${path} claim order matches the SDK`);
    ok(claims.sub === "kid-1" && claims.iss === "cdp" && claims.nbf === claims.iat && claims.exp - claims.iat === 120, `${label}: ${path} sub, iss, 120 s window`);
    ok(claims.uris.length === 1 && claims.uris[0] === `${method} api.cdp.coinbase.com/platform/v2/x402/${path}`, `${label}: ${path} uris claim`);
    const [a, b, s] = jwt.split(".");
    ok(check(`${a}.${b}`, Buffer.from(s, "base64url")), `${label}: ${path} signature verifies`);
  }
  ok(nonces.size === 3, `${label}: a fresh nonce per path`);
}

// A fresh JWT per call: CDP refuses a token past its 120 s window, so a
// config that cached its headers would 401 every verify and settle two
// minutes after boot. Two calls differ, and a call made later carries the
// later clock.
{
  const cfg = cdpFacilitatorConfig("kid-fresh", edSecret);
  const a = await cfg.createAuthHeaders();
  const b = await cfg.createAuthHeaders();
  for (const path of Object.keys(PATHS)) {
    const ta = a[path].Authorization, tb = b[path].Authorization;
    ok(ta && tb && ta !== tb && part(ta.slice(7), 0).nonce !== part(tb.slice(7), 0).nonce, `fresh per call: ${path} gets a new token and nonce on each call`);
  }
  const realNow = Date.now;
  const before = part(a.settle.Authorization.slice(7), 1);
  Date.now = () => realNow() + 600_000;
  let later;
  try { later = part((await cfg.createAuthHeaders()).settle.Authorization.slice(7), 1); } finally { Date.now = realNow; }
  ok(later.iat >= before.iat + 600 && later.exp === later.iat + 120, `fresh per call: a call 600 s later is signed at its own time (iat ${before.iat} -> ${later.iat})`);
}

// No keys: correlation only, no Authorization anywhere (the package's shape).
{
  const saved = [process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET];
  delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET;
  const h = await cdpFacilitatorConfig().createAuthHeaders();
  ok(Object.values(h).every((g) => !("Authorization" in g) && g["Correlation-Context"]), "no keys: correlation headers only");
  process.env.CDP_API_KEY_ID = "env-kid"; process.env.CDP_API_KEY_SECRET = edSecret;
  const he = await cdpFacilitatorConfig().createAuthHeaders();
  ok(part(he.settle.Authorization.slice(7), 0).kid === "env-kid", "keys read from the environment at call time");
  if (saved[0] === undefined) delete process.env.CDP_API_KEY_ID; else process.env.CDP_API_KEY_ID = saved[0];
  if (saved[1] === undefined) delete process.env.CDP_API_KEY_SECRET; else process.env.CDP_API_KEY_SECRET = saved[1];
}

// Caller path: @x402/core's own HTTPFacilitatorClient, given this config with
// the URL pointed at a local stub, sends each path's Authorization and
// Correlation-Context on the wire.
{
  const { createServer } = await import("node:http");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", corr: req.headers["correlation-context"] || "" });
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/supported")) res.end(JSON.stringify({ kinds: [], extensions: [], signers: {} }));
      else if (req.url.endsWith("/settle")) res.end(JSON.stringify({ success: false, errorReason: "stub", transaction: "", network: "eip155:8453", payer: "0x0000000000000000000000000000000000000000" }));
      else res.end(JSON.stringify({ isValid: false, invalidReason: "stub", payer: "0x0000000000000000000000000000000000000000" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const cfg = cdpFacilitatorConfig("kid-wire", edSecret);
  const client = new HTTPFacilitatorClient({ ...cfg, url: `http://127.0.0.1:${srv.address().port}/platform/v2/x402` });
  try { await client.getSupported(); } catch { /* the stub's body shape is not under test */ }
  try { await client.verify({ x402Version: 2, payload: {}, accepted: {} }, { scheme: "exact", network: "eip155:8453" }); } catch { /* same */ }
  try { await client.settle({ x402Version: 2, payload: {}, accepted: {} }, { scheme: "exact", network: "eip155:8453" }); } catch { /* same */ }
  srv.close();
  for (const [path, method] of [["supported", "GET"], ["verify", "POST"], ["settle", "POST"]]) {
    const r = seen.find((s) => s.url === `/platform/v2/x402/${path}`);
    ok(r && r.method === method, `wire: ${path} reached the stub as ${method}`);
    const claims = r && r.auth.startsWith("Bearer ") ? part(r.auth.slice(7), 1) : {};
    ok(claims.sub === "kid-wire" && claims.uris?.[0] === `${method} api.cdp.coinbase.com/platform/v2/x402/${path}`, `wire: ${path} carries its own signed JWT`);
    ok(r && r.corr === cdpCorrelationHeader(), `wire: ${path} carries Correlation-Context`);
  }
}

// The server builds its CDP client from this module, and the package is gone.
const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
ok(/import\("\.\/cdp-facilitator\.js"\)/.test(payments) && !/import\(["']@coinbase\/x402["']\)/.test(payments), "payments.js builds the CDP config from src/cdp-facilitator.js");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
ok(!pkg.dependencies?.["@coinbase/x402"] && !pkg.dependencies?.["@coinbase/cdp-sdk"], "package.json no longer installs @coinbase/x402 or @coinbase/cdp-sdk");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
