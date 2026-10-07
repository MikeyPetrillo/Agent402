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
ok(CDP_TOOLS.length === 5, "kit exports 5 tools");
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
await rejects(() => tool("testnet-fund").handler({ address: "0x1111111111111111111111111111111111111111", network: "polygon-amoy" }), 400, "testnet-fund unsupported network → 400");
await rejects(() => tool("testnet-fund").handler({ address: "0x1111111111111111111111111111111111111111", network: "solana-devnet" }), 400, "testnet-fund EVM address rejected on solana-devnet → 400");
await rejects(() => tool("testnet-fund").handler({ address: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", network: "solana-devnet", token: "eth" }), 400, "testnet-fund eth not a solana token → 400");
await rejects(() => tool("testnet-fund").handler({ address: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", network: "solana-devnet", token: "usdc" }), 503, "testnet-fund solana-devnet valid input reaches the env gate (503 without keys)");
await rejects(() => tool("wallet-balances").handler({ address: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", network: "solana" }), 503, "wallet-balances solana valid base58 reaches the env gate (503 without keys)");
await rejects(() => tool("wallet-balances").handler({ address: "0x1111111111111111111111111111111111111111", network: "solana" }), 400, "wallet-balances EVM address rejected on solana → 400");
await rejects(() => tool("onchain-sql").handler({}), 400, "onchain-sql missing sql → 400");
await rejects(() => tool("onchain-sql").handler({ sql: "DROP TABLE base.events" }), 400, "onchain-sql non-SELECT → 400");
await rejects(() => tool("onchain-sql").handler({ sql: "SELECT " + "x,".repeat(6000) + "y FROM base.events" }), 400, "onchain-sql over-length → 400");
await rejects(() => tool("onchain-sql").handler({ sql: "SELECT 1" }), 503, "onchain-sql valid SELECT reaches the env gate (503 without keys)");
await rejects(() => tool("onchain-sql").handler({ sql: "WITH t AS (SELECT 1) SELECT * FROM t" }), 503, "onchain-sql WITH…SELECT accepted (503 at env gate)");
await rejects(() => tool("onchain-sql-schema").handler({}), 503, "onchain-sql-schema reaches the env gate (503 without keys)");
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
  // One global slot is already occupied (the rollover grant above; the
  // solana-devnet valid-input test passed the gate, hit the env gate, and its
  // failed drip gave the slot back), so exactly 7 of these 12 fit under 8/day.
  let granted = 0;
  for (let i = 0; i < 12; i++) if (faucetGate("0x" + String(i).padStart(40, "0"), t0 + 10).ok) granted++;
  ok(granted === 7, `global 8/day budget enforced across addresses (granted ${granted}/12, 1 slot already used)`);
}

// --- upstream mapping: 429, auth, timeouts, the faucet slot (stubbed fetch) ----
{
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
  process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "pkcs8", format: "pem" });
  const realFetch = globalThis.fetch;
  let calls = [];
  let reply = null;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || "GET" }); return reply(calls.length); };
  const J = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const timeout = () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  const addr = (c) => "0x" + c.repeat(40);
  const bal = () => tool("wallet-balances").handler({ address: addr("1"), network: "base" });
  const fund = (a) => tool("testnet-fund").handler({ address: a });
  try {
    // 429: retried once, honoring a short Retry-After, then a 503 with no CDP detail.
    calls = []; reply = () => J(429, { errorMessage: "SECRET-UPSTREAM-DETAIL" }, { "retry-after": "0" });
    const t = Date.now();
    let e = await bal().catch((x) => x);
    ok(e?.statusCode === 503 && !/SECRET/.test(e.message) && calls.length === 2, `a 429 is retried once, then an uncharged 503 without the upstream detail (attempts ${calls.length}, status ${e?.statusCode})`);
    ok(Date.now() - t < 1500, "Retry-After 0 is honored instead of the long backoff");
    calls = []; reply = (n) => (n === 1 ? J(429, {}) : J(200, { balances: [] }));
    const r = await bal();
    ok(r.count === 0 && calls.length === 2, "a single 429 then 200 recovers");
    // 401/403: this server's configuration.
    for (const st of [401, 403]) {
      calls = []; reply = () => J(st, { errorMessage: "SECRET-UPSTREAM-DETAIL key organizations/test" });
      e = await bal().catch((x) => x);
      ok(e?.statusCode === 503 && /not configured/.test(e.message) && !/SECRET|organizations/.test(e.message) && calls.length === 1, `${st} -> 503 not configured, not retried, no upstream text`);
    }
    // A faucet POST that timed out is never resent, and its slot is kept (it may have dripped).
    calls = []; reply = timeout;
    e = await fund(addr("b")).catch((x) => x);
    ok(e?.statusCode === 504 && calls.length === 1, `a faucet POST that timed out is not retried (attempts ${calls.length})`);
    calls = []; reply = () => J(200, { transactionHash: "0xabc" });
    const f1 = await fund(addr("b"));
    const f2 = await fund(addr("b")).catch((x) => x);
    ok(f1.funded && f2?.statusCode === 429, "a timed-out drip keeps its slot: the address gets one more drip, not two");
    // A drip refused outright gives its slot back.
    calls = []; reply = () => J(400, { errorMessage: "bad request" });
    await fund(addr("d")).catch(() => {});
    reply = () => J(200, { transactionHash: "0xabd" });
    ok((await fund(addr("d"))).funded && (await fund(addr("d"))).funded, "a refused drip gave its slot back: the address still gets its two drips");
    // A response with no transaction is a failed drip: 502, slot returned.
    calls = []; reply = () => J(200, {});
    e = await fund(addr("c")).catch((x) => x);
    ok(e?.statusCode === 502, "a faucet answer with no transaction hash is a 502, never a charged funded:false");
    reply = () => J(200, { transactionHash: "0xdef" });
    ok((await fund(addr("c"))).funded && (await fund(addr("c"))).funded, "and its slot was returned");
    // Control: a GET that timed out is still retried.
    calls = []; reply = (n) => (n === 1 ? timeout() : J(200, { balances: [] }));
    ok((await bal()).count === 0 && calls.length === 2, "a GET that timed out is retried");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET;
  }
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
