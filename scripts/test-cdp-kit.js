// CDP kit — offline unit tests. No network, no real keys: verifies the JWT
// minting against locally generated EC + Ed25519 keypairs (signature must
// cryptographically verify; claims must match the CDP contract), the input
// validation of all three handlers, the env gate (503 without keys), and the
// faucet's local rate gate.
//
//   node scripts/test-cdp-kit.js
import { generateKeyPairSync, createVerify, verify as edVerify } from "node:crypto";

delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;
const { CDP_TOOLS, mintCdpJwt, faucetGate } = await import("../src/tools/cdp-kit.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const tool = (slug) => CDP_TOOLS.find((t) => t.slug === slug);
const rejects = async (fn, status, msg) => {
  try { await fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(e.statusCode === status, `${msg} (got ${e.statusCode}: ${String(e.message).slice(0, 60)})`); }
};

// --- kit shape ---------------------------------------------------------------
ok(CDP_TOOLS.length === 3, "kit exports 3 tools");
for (const t of CDP_TOOLS) {
  ok(t.route && t.slug && t.price && t.discovery?.inputSchema && typeof t.handler === "function", `${t.slug} has the full tool contract`);
}

// --- JWT: Ed25519 (base64 seed+pub — the current CDP key format) --------------
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwkPriv = privateKey.export({ format: "jwk" });
  const secret = Buffer.concat([
    Buffer.from(jwkPriv.d, "base64url"),
    Buffer.from(jwkPriv.x, "base64url"),
  ]).toString("base64");
  const jwt = await mintCdpJwt({ method: "POST", path: "/platform/v2/evm/faucet", apiKeyId: "test-key-id", apiKeySecret: secret });
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  ok(header.alg === "EdDSA" && header.kid === "test-key-id" && header.typ === "JWT" && header.nonce?.length === 32, "Ed25519 JWT header (alg/kid/typ/nonce)");
  ok(claims.sub === "test-key-id" && claims.iss === "cdp", "claims carry sub + iss=cdp");
  ok(Array.isArray(claims.uris) && claims.uris[0] === "POST api.cdp.coinbase.com/platform/v2/evm/faucet", "uris claim is 'METHOD host+path'");
  // Regression lock: query strings must NOT be signed into the uris claim —
  // CDP validates against the pathname only (a signed query returns 401).
  const jwtQ = await mintCdpJwt({ method: "GET", path: "/platform/v2/evm/token-balances/base/0xabc?pageSize=100", apiKeyId: "test-key-id", apiKeySecret: secret });
  const claimsQ = JSON.parse(Buffer.from(jwtQ.split(".")[1], "base64url").toString());
  ok(claimsQ.uris[0] === "GET api.cdp.coinbase.com/platform/v2/evm/token-balances/base/0xabc", "query string excluded from the uris claim");
  ok(claims.exp - claims.iat === 120 && claims.nbf === claims.iat, "iat/nbf/exp window is 120s");
  const valid = edVerify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
  ok(valid, "Ed25519 signature cryptographically verifies");
}

// --- JWT: EC P-256 PEM (legacy CDP key format) ---------------------------------
{
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = await mintCdpJwt({ method: "GET", path: "/platform/v2/evm/token-balances/base/0xabc", apiKeyId: "ec-key", apiKeySecret: pem });
  const [h, p, s] = jwt.split(".");
  ok(JSON.parse(Buffer.from(h, "base64url").toString()).alg === "ES256", "PEM EC key selects ES256");
  const v = createVerify("SHA256").update(`${h}.${p}`);
  ok(v.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "ES256 signature verifies (ieee-p1363)");
}

// --- env gate: no keys → 503, and validation fires BEFORE the gate -------------
await rejects(() => tool("wallet-balances").handler({ address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }), 503, "wallet-balances without CDP keys → 503");
await rejects(() => tool("wallet-balances").handler({ address: "nope" }), 400, "wallet-balances bad address → 400");
await rejects(() => tool("wallet-balances").handler({ address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "dogechain" }), 400, "wallet-balances bad network → 400");
await rejects(() => tool("testnet-fund").handler({ address: "short" }), 400, "testnet-fund bad address → 400");
await rejects(() => tool("testnet-fund").handler({ address: "0x1111111111111111111111111111111111111111", token: "btc" }), 400, "testnet-fund bad token → 400");
await rejects(() => tool("onramp-link").handler({ address: "0x1111111111111111111111111111111111111111", network: "tron" }), 400, "onramp-link bad network → 400");
await rejects(() => tool("onramp-link").handler({ address: "notanaddress", network: "base" }), 400, "onramp-link EVM address enforced on EVM networks → 400");
await rejects(() => tool("onramp-link").handler({ address: "0x1111111111111111111111111111111111111111", amount: "-5" }), 400, "onramp-link bad amount → 400");
await rejects(() => tool("onramp-link").handler({ address: "0x1111111111111111111111111111111111111111", redirectUrl: "http://insecure" }), 400, "onramp-link non-https redirect → 400");

// --- faucet local gate ---------------------------------------------------------
{
  const a = "0x" + "a".repeat(40);
  const t0 = 1_000_000_000_000;
  ok(faucetGate(a, t0).ok && faucetGate(a, t0 + 1).ok, "two drips per address allowed");
  ok(!faucetGate(a, t0 + 2).ok, "third drip within 24h refused");
  ok(faucetGate(a, t0 + 25 * 60 * 60 * 1000).ok, "window rolls over after 24h");
  // One global slot is still occupied (the rollover grant above), so exactly
  // 7 of these 12 fresh addresses fit under the 8/day budget.
  let granted = 0;
  for (let i = 0; i < 12; i++) if (faucetGate("0x" + String(i).padStart(40, "0"), t0 + 10).ok) granted++;
  ok(granted === 7, `global 8/day budget enforced across addresses (granted ${granted}/12, 1 slot already used)`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
