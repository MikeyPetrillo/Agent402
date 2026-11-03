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

// --- JWT: a PEM that is not EC P-256 is refused at mint time, key not echoed ---
for (const [label, kp] of [
  ["EC secp384r1", generateKeyPairSync("ec", { namedCurve: "secp384r1" })],
  ["EC secp256k1", generateKeyPairSync("ec", { namedCurve: "secp256k1" })],
  ["RSA", generateKeyPairSync("rsa", { modulusLength: 2048 })],
]) {
  const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
  const body = pem.split("\n")[1];
  try {
    await mintCdpJwt({ method: "GET", path: "/platform/v2/evm/token-balances/base/0xabc", apiKeyId: "ec-key", apiKeySecret: pem });
    ok(false, `${label} PEM is refused (minted a token)`);
  } catch (e) {
    ok(e.statusCode === 503 && /P-256/.test(e.message) && !e.message.includes(body) && !/BEGIN/.test(e.message), `${label} PEM is refused with a 503 naming the key type, never the key (${e.statusCode}: ${String(e.message).slice(0, 80)})`);
  }
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
    ok(e?.statusCode === 503 && e?.attribution === "upstream" && /^Coinbase Developer Platform did not answer the faucet read within 15 s \(upstream deadline\)/.test(e.message) && calls.length === 1,
      `a faucet POST that timed out is a 503 naming the step and is not retried (attempts ${calls.length}, ${e?.statusCode} "${e?.message}")`);
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
    // A buyer's query (onchain-sql): a slow 502 is answered once, a fast 5xx
    // is tried twice, and the answer says how to narrow the query.
    const { _setSlowQueryGatewayMsForTest, _setQueryHealthForTest, QUERY_HEALTH_SQL } = await import("../src/tools/cdp-kit.js");
    _setSlowQueryGatewayMsForTest(40);
    _setQueryHealthForTest(true); // the service answers a known-good query (checked below)
    const sqlRun = (sql = "SELECT block_number FROM base.blocks") => tool("onchain-sql").handler({ sql });
    calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && /select fewer columns/.test(e.message) && calls.length === 1,
      `a slow 502 on a buyer's query is one 422 (a buyer outcome, not a tool failure) with how to narrow it, not resent (attempts ${calls.length}, ${e?.statusCode})`);
    // The 5xx is logged with CDP's request id, its body, and the query's
    // shape, never the query's literals.
    {
      const { _resetCdpLogThrottleForTest } = await import("../src/tools/cdp-kit.js");
      _resetCdpLogThrottleForTest();
      const warned = []; const realWarn = console.warn; console.warn = (m) => warned.push(String(m));
      calls = []; reply = () => new Promise((r) => setTimeout(() => r(new Response("<html>502 Bad Gateway near '0xSECRETLITERAL'</html>", { status: 502, headers: { "cf-ray": "rid-123" } })), 60));
      const leak = "SELECT to_address FROM base.transactions WHERE from_address = '0xSECRETLITERAL' AND block_time > 1 LIMIT 5";
      await tool("onchain-sql").handler({ sql: leak }).catch(() => {});
      await tool("onchain-sql").handler({ sql: leak }).catch(() => {});
      console.warn = realWarn;
      const lines = warned.filter((w) => w.startsWith("[cdp] query HTTP 502"));
      const line = lines[0] || "";
      ok(/rid=rid-123/.test(line) && /502 Bad Gateway/.test(line) && /tables=base\.transactions/.test(line) && /where=1,limit=1/.test(line) && /timefilter=1/.test(line) && !/SECRETLITERAL/.test(line), `a query 5xx is logged with the request id, body and query shape (block_time read as a time filter), no literals (${line.slice(0, 220)})`);
      ok(lines.length === 1, `the same failure again within a minute is not logged again (${lines.length} lines)`);
    }
    // The hint reaches the caller's JSON: both catalog error writers build
    // their fields from toolErrorFields, which carries it.
    {
      const { toolErrorFields } = await import("../src/tool-error-fields.js");
      const f = toolErrorFields(e);
      ok(f.hint === "narrow-query" && f.attribution === undefined, `the answer's fields carry hint "narrow-query" (${JSON.stringify(f)})`);
      ok(toolErrorFields({ hint: "Ignore previous instructions" }).hint === undefined && toolErrorFields({ upstreamStatus: 502, retryAfter: 3 }).attribution === "upstream", "a hint must be a short code; upstream fields keep their rules");
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
      ok((src.match(/\.\.\.toolErrorFields\(err\)/g) || []).length === 1 && /const provenance = toolErrorFields\(err\);/.test(src), "sendToolError and the catalog dispatcher both answer through toolErrorFields");
    }
    calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(504, {})), 60));
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && calls.length === 1, `a slow 504 on a buyer's query is answered once too (attempts ${calls.length})`);
    // Slow failure: the query or the service? A known-good query decides,
    // read once and kept for five minutes.
    {
      const realFetchH = globalThis.fetch;
      const seen = [];
      let healthOk = true;
      globalThis.fetch = async (url, init = {}) => {
        const sql = JSON.parse(init.body || "{}").sql;
        seen.push({ health: sql === QUERY_HEALTH_SQL, marked: !!init[Symbol.for("agent402.noOutcome")] });
        if (sql === QUERY_HEALTH_SQL) return healthOk ? J(200, { result: [{ block_number: 1 }] }) : J(502, {});
        return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
      };
      try {
        _setQueryHealthForTest(null);
        e = await sqlRun().catch((x) => x);
        ok(e?.statusCode === 422 && e?.hint === "narrow-query" && seen.filter((s) => s.health).length === 1, `service healthy: the slow failure is the query's (422 narrow-query), one health read (${e?.statusCode})`);
        ok(seen.find((s) => !s.health)?.marked === true && seen.find((s) => s.health)?.marked === false, "a buyer's query is not counted in the upstream lane; the health read is");
        e = await sqlRun().catch((x) => x);
        ok(e?.statusCode === 422 && seen.filter((s) => s.health).length === 1, "the health reading is kept: a second slow failure reads no health again");
        healthOk = false; _setQueryHealthForTest(null); seen.length = 0;
        e = await sqlRun().catch((x) => x);
        ok(e?.statusCode === 502 && !e?.hint && /known-good query failed too/.test(e.message), `service failing: the slow failure is a 502 tool failure, not the buyer's (${e?.statusCode} ${String(e?.message).slice(0, 80)})`);
      } finally { globalThis.fetch = realFetchH; _setQueryHealthForTest(true); }
    }
    // A 503 is the service unavailable: retried, then a plain upstream error, never "narrow it".
    calls = []; reply = () => J(503, {});
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 502 && !e?.hint && /retry shortly/.test(e.message) && !/narrow/i.test(e.message) && calls.length === 2, `a 503 is retried and answered as an upstream error to retry (attempts ${calls.length}, hint ${e?.hint})`);
    // A fast 500 (a result too large to return) is tried twice, then answered the same way.
    calls = []; reply = () => J(500, { errorMessage: "An internal server error occurred." });
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 502 && e?.hint === "narrow-query" && calls.length === 2, `a fast 500 on a buyer's query is tried twice, then narrow-query (attempts ${calls.length})`);
    // Control: a fast 502 that clears is served.
    calls = []; reply = (n) => (n === 1 ? J(502, {}) : J(200, { result: [{ x: 1 }] }));
    const q = await sqlRun();
    ok(q.rowCount === 1 && calls.length === 2, `a fast 502 then a 200 is served (attempts ${calls.length})`);
    // The row cap: a plain SELECT is wrapped with LIMIT 1001; 1,001 rows back
    // means the result was cut, and the answer says so in fields.
    {
      const { cappedSql, SQL_MAX_ROWS } = await import("../src/tools/cdp-kit.js");
      const W = (inner) => `SELECT * FROM (\n${inner}\n) LIMIT ${SQL_MAX_ROWS + 1}`;
      ok(cappedSql("SELECT a FROM base.blocks;").sql === W("SELECT a FROM base.blocks"), "a plain SELECT is wrapped with the row cap on its own lines (trailing semicolon dropped)");
      ok(cappedSql("SELECT 1 AS x -- note").sql === W("SELECT 1 AS x -- note") && cappedSql("SELECT a FROM t # c").sql === W("SELECT a FROM t # c"), "a trailing line comment ends before the wrapper's closing parenthesis");
      ok(cappedSql("SELECT a FROM t LIMIT 5; -- end").sql === W("SELECT a FROM t LIMIT 5") && cappedSql("SELECT a FROM t; /* end */").sql === W("SELECT a FROM t"), "a final semicolon and the comments after it are dropped");
      ok(cappedSql("SELECT a FROM t WHERE x = '; --'").sql === W("SELECT a FROM t WHERE x = '; --'"), "a semicolon or comment marker inside a string is left alone");
      ok(cappedSql("WITH t AS (SELECT 1) SELECT * FROM t").capped === false && cappedSql("-- lead\nWITH t AS (SELECT 1) SELECT * FROM t").capped === false && cappedSql("SELECT a FROM t SETTINGS max_threads = 1").capped === false, "WITH (after a comment too), SETTINGS and FORMAT queries are sent as written");
      ok(cappedSql("SELECT parameters['format'] FROM base.events").capped === true, "a SETTINGS or FORMAT word inside a string does not turn the cap off");
      const lead = await sqlRun("-- the daily count\nWITH t AS (SELECT 1 AS x) SELECT * FROM t").catch((x) => x);
      ok(!(lead instanceof Error) || !/read-only SELECT/.test(lead.message), "a query opening with a comment passes the read-only check");
      let sent = null;
      calls = []; reply = () => J(200, { result: Array.from({ length: SQL_MAX_ROWS + 1 }, (_, i) => ({ i })) });
      const realFetchCap = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => { sent = JSON.parse(init.body || "{}").sql; return realFetchCap(url, init); };
      const big = await sqlRun("SELECT i FROM base.blocks");
      ok(/LIMIT 1001$/.test(sent) && big.rows.length === SQL_MAX_ROWS && big.truncated === true && big.complete === false && big.matchedIsLowerBound === true && /More than 1000 rows/.test(big.note), `a result past the cap is cut at ${SQL_MAX_ROWS} and marked truncated (${big.rows.length}, truncated ${big.truncated})`);
      const cutRaw = await sqlRun("WITH t AS (SELECT i FROM base.blocks) SELECT * FROM t");
      ok(cutRaw.truncated === true && cutRaw.matchedIsLowerBound === undefined && cutRaw.rowCapApplied === false, "a query sent unwrapped and cut here reports an exact match count, not a lower bound");
      reply = () => J(200, { result: [{ i: 1 }] });
      const small = await sqlRun("SELECT i FROM base.blocks");
      ok(small.truncated === false && small.complete === true && small.rowCount === 1 && small.maxRows === SQL_MAX_ROWS, "a result under the cap is marked complete");
      globalThis.fetch = realFetchCap;
    }
    // solana.instructions without a block_time range: a filter, group, order
    // or aggregate is refused before any call; a bare sample and a ranged
    // query are sent; the narrow-query answer names block_time for Solana.
    {
      const { solanaRangeRefusal } = await import("../src/tools/cdp-kit.js");
      ok(solanaRangeRefusal("SELECT executing_account, COUNT(*) FROM solana.instructions WHERE tx_signer = 'x' GROUP BY executing_account") !== null, "a Solana aggregate with no block_time range is refused");
      ok(solanaRangeRefusal("SELECT * FROM solana.instructions WHERE tx_signer = 'x'") !== null, "a Solana filter with no block_time range is refused");
      ok(solanaRangeRefusal("SELECT * FROM solana.instructions LIMIT 5") === null, "a bare Solana sample is sent");
      ok(solanaRangeRefusal("SELECT COUNT(*) FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY") === null, "a Solana query with a block_time range is sent");
      ok(solanaRangeRefusal("SELECT COUNT(*) FROM base.transactions WHERE block_number > 1") === null, "a Base query is not judged by the Solana rule");
      ok(solanaRangeRefusal("SELECT count() FROM solana.instructions") === null && solanaRangeRefusal("SELECT COUNT(*) AS n FROM solana.instructions") === null, "a bare count is sent (answered from metadata, measured 0.2 s)");
      ok(solanaRangeRefusal("SELECT anything, any_data FROM solana.instructions LIMIT 5") === null, "a column named like an aggregate is not an aggregate");
      ok(solanaRangeRefusal("SELECT * FROM solana.instructions /* where */ LIMIT 3") === null, "a keyword inside a comment does not count");
      ok(solanaRangeRefusal("SELECT sum(stack_height) FROM solana.instructions") !== null, "an aggregate call other than a bare count is refused");
      ok(solanaRangeRefusal("SELECT * FROM solana.instructions WHERE tx_signer = 'block_time'") !== null, "block_time inside a string is not a range");
      // The days a query covers are read from its block_time comparisons
      // only (never an INTERVAL elsewhere or a value in a comment) and named
      // in the narrow-query answer; the range itself is judged by the
      // service, since what it reads depends on columns and filters.
      const { blockTimeRangeDays, sqlNorm } = await import("../src/tools/cdp-kit.js");
      const at = Date.parse("2026-11-03T00:00:00Z");
      const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.01;
      ok(blockTimeRangeDays("SELECT 1 FROM solana.instructions WHERE block_time > now() - INTERVAL 30 DAY", at) === 30 && blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 2 WEEK", at) === 14 && near(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 12 HOUR", at), 0.5), "INTERVAL ranges on block_time are read in days");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time BETWEEN now() - INTERVAL 37 DAY AND now() - INTERVAL 30 DAY", at) === 7, "a week a month ago is a week (both bounds read)");
      ok(blockTimeRangeDays("SELECT toStartOfInterval(block_time, INTERVAL 1 MONTH) AS m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m", at) === 1, "an INTERVAL in a function is not the range");
      ok(blockTimeRangeDays("SELECT 1 FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY AND tx_id IN (SELECT h FROM base.events WHERE block_timestamp > now() - INTERVAL 30 DAY)", at) === 1, "an INTERVAL on another table's column is not the range");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 1 DAY -- was block_time >= '2020-01-01'", at) === 1 && blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 1 DAY /* and block_time < '2026-01-01' */", at) === 1, "a value in a comment is not a bound (neither a lower nor an upper one)");
      ok(blockTimeRangeDays("SELECT 1 WHERE \"block_time\" > now() - INTERVAL 2 DAY", at) === 2 && blockTimeRangeDays("SELECT 1 FROM `solana`.`instructions` WHERE block_time >= '2026-10-01' AND block_time < '2026-10-05'", at) === 4, "quoted identifiers read as the plain names; two absolute dates give their span");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time >= toDateTime('2026-10-01 00:00:00')", at) === 33 && blockTimeRangeDays("SELECT 1 WHERE '2026-10-30' <= block_time", at) === 4, "a date function and a reversed comparison are read; one bound spans to now");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > subtractDays(now(), 3)", at) === 3 && blockTimeRangeDays("SELECT 1 WHERE block_time > today() - 5", at) === 5, "subtractDays and today() - N are read");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > someFunc(x)", at) === null && blockTimeRangeDays("SELECT 1 WHERE tx_signer = 'x'", at) === null, "a bound this reader does not know, or no block_time, reads no range");
      ok(sqlNorm("SELECT a FROM `solana`.`instructions` WHERE \"tx_signer\" = 'where'") === "SELECT a FROM solana.instructions WHERE tx_signer = '_____'", "sqlNorm keeps identifiers and masks strings");
      const wide = "SELECT instruction_name, COUNT(*) AS n FROM solana.instructions WHERE block_time > now() - INTERVAL 30 DAY AND tx_signer = 'x' GROUP BY instruction_name LIMIT 5";
      ok(solanaRangeRefusal(wide) === null && solanaRangeRefusal("SELECT a FROM `solana`.`instructions` WHERE tx_signer = 'x'") !== null, "a ranged query is sent whatever its length (the service judges what it reads); a backticked table with no range is still refused");
      calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(502, {})), 60));
      const rw = await tool("onchain-sql").handler({ sql: wide }).catch((x) => x);
      ok(rw?.statusCode === 422 && rw?.hint === "narrow-query" && /covers about 30 days/.test(rw.message) && /start at a day/.test(rw.message) && calls.length === 1, `a 30-day Solana aggregate the service refuses is answered with the days it covered and a day to start from (${rw?.statusCode}, calls ${calls.length})`);
      calls = [];
      const r = await tool("onchain-sql").handler({ sql: "SELECT executing_account, COUNT(*) AS n FROM solana.instructions GROUP BY executing_account" }).catch((x) => x);
      ok(r?.statusCode === 400 && r?.hint === "add-block-time" && /block_time > now\(\) - INTERVAL 1 DAY/.test(r.message) && calls.length === 0, `the handler refuses it before calling the query service (${r?.statusCode}, calls ${calls.length})`);
      calls = []; reply = () => new Promise((res) => setTimeout(() => res(J(502, {})), 60));
      const s5 = await tool("onchain-sql").handler({ sql: "SELECT * FROM solana.instructions WHERE block_time > now() - INTERVAL 7 DAY" }).catch((x) => x);
      ok(s5?.hint === "narrow-query" && /block_time range \(start at a day/.test(s5.message), `a Solana narrow-query answer names block_time (${String(s5?.message).slice(0, 120)})`);
    }
    // Control: a slow 502 on a query another reader runs (cdpSql) is still retried.
    {
      const { cdpSql } = await import("../src/tools/cdp-kit.js");
      calls = []; reply = (n) => (n === 1 ? new Promise((r) => setTimeout(() => r(J(502, {})), 60)) : J(200, { result: [{ x: 1 }] }));
      const rows = await cdpSql("SELECT 1");
      ok(rows.length === 1 && calls.length === 2, `a slow 502 on another reader's query is retried, not given the narrow-query answer (attempts ${calls.length})`);
    }
    // The body snippet in the log hides literals a 5xx body may echo.
    {
      const { redactLiterals } = await import("../src/tools/cdp-kit.js");
      const out = redactLiterals(`error near 'buyer-secret-value' in WHERE from_address = 0xabcdef0123456789 AND block_number > 12345678`);
      ok(!/buyer-secret-value|0xabcdef0123|12345678/.test(out) && /error near/.test(out), `5xx body literals are redacted in the log (${out})`);
    }
    // Control: a slow 502 on another read is still retried.
    calls = []; reply = (n) => (n === 1 ? new Promise((r) => setTimeout(() => r(J(502, {})), 60)) : J(200, { balances: [] }));
    ok((await bal()).count === 0 && calls.length === 2, "a slow 502 on a balances read is still retried");
    _setSlowQueryGatewayMsForTest(8_000);
    // Control: a GET that timed out is still retried.
    calls = []; reply = (n) => (n === 1 ? timeout() : J(200, { balances: [] }));
    ok((await bal()).count === 0 && calls.length === 2, "a GET that timed out is retried");
    // The retry walk composes with the handler budget: a GET whose every
    // attempt stalls ends as one deadline answer inside the budget, not up to
    // five 15 s caps plus backoff.
    process.env.UPSTREAM_HANDLER_BUDGET_MS = "1500";
    const keep = setInterval(() => {}, 1000);
    const signals = [];
    globalThis.fetch = (url, init = {}) => new Promise((_, reject) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      signals.push(init.signal);
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true });
    });
    calls = [];
    const t1 = Date.now();
    e = await bal().catch((x) => x);
    const ms = Date.now() - t1;
    clearInterval(keep);
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    ok(e?.statusCode === 503 && e?.upstreamFailure === "deadline" && /token balances read/.test(e.message) && calls.length === 1 && ms >= 1400 && ms < 3000,
      `a stalled GET under a 1.5 s budget is one 503 deadline at the budget, with no retry it cannot hold (${calls.length} attempt(s), ${ms} ms, "${e?.message}")`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET;
  }
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
