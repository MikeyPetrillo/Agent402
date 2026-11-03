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
    const { _setSlowQueryGatewayMsForTest, _setQueryHealthForTest, QUERY_HEALTH_SQL, _setHealthTimeoutMsForTest, HEALTH_TIMEOUT_MS, HEALTH_TTL_MS, BUYER_QUERY_INFLIGHT_MAX, _buyerQueriesInflightForTest, _cdpLogThrottleSizeForTest } = await import("../src/tools/cdp-kit.js");
    const isHealth = (sql) => Object.values(QUERY_HEALTH_SQL).includes(sql);
    _setSlowQueryGatewayMsForTest(40);
    _setQueryHealthForTest(true); // the service answers a known-good query (checked below)
    const sqlRun = (sql = "SELECT block_number FROM base.blocks") => tool("onchain-sql").handler({ sql });
    calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 422 && e?.hint === "narrow-query" && /answer window of about 10 s, reads more than its 100 GB/.test(e.message) && /select fewer columns/.test(e.message) && calls.length === 1,
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
      // A configured secret is redacted on the whole body before the 4 KB
      // slice: a body whose first 4 KB is one long string that then holds the
      // key would otherwise print the key's start after the string collapses.
      _resetCdpLogThrottleForTest();
      const warned2 = []; console.warn = (m) => warned2.push(String(m));
      calls = []; reply = () => new Promise((r) => setTimeout(() => r(new Response("'" + "x".repeat(3_980) + "' " + process.env.CDP_API_KEY_ID + " tail", { status: 502 })), 60));
      await tool("onchain-sql").handler({ sql: "SELECT block_number FROM base.blocks LIMIT 1" }).catch(() => {});
      console.warn = realWarn;
      const line2 = warned2.find((w) => w.startsWith("[cdp] query HTTP 502")) || "";
      ok(line2 && !/organiz|apiKeys/.test(line2), `a secret past the slice point is redacted whole, never printed in part (${line2.slice(0, 120)})`);
      // The failed query's own text is logged (operator-only), once a minute
      // per distinct query, so it can be run again by hand; an internal
      // reader's query (cdpSql) is not.
      {
        _resetCdpLogThrottleForTest();
        const warned3 = []; console.warn = (m) => warned3.push(String(m));
        const q = "SELECT instruction_name, count() AS n FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY AND tx_signer = 'FAILQ'\nGROUP BY instruction_name";
        calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(502, {})), 60));
        await tool("onchain-sql").handler({ sql: q }).catch(() => {});
        await tool("onchain-sql").handler({ sql: q }).catch(() => {});
        calls = []; reply = () => J(400, { errorMessage: "Query scanned more data than the per-query limit allows" });
        await tool("onchain-sql").handler({ sql: q + " LIMIT 7" }).catch(() => {});
        const { cdpSql } = await import("../src/tools/cdp-kit.js");
        calls = []; reply = () => J(500, {});
        await cdpSql("SELECT 'INTERNALQ' FROM base.blocks").catch(() => {});
        console.warn = realWarn;
        const q1 = warned3.filter((w) => w.startsWith("[cdp] failed buyer query") && w.includes("FAILQ") && !w.includes("LIMIT 7"));
        const q2 = warned3.filter((w) => w.startsWith("[cdp] failed buyer query") && w.includes("LIMIT 7"));
        ok(q1.length === 1 && q1[0].includes("HTTP 502") && q1[0].includes("\\n") && q2.length === 1 && q2[0].includes("HTTP 400"), `a failed buyer query's text is logged once per distinct query, on one line, for a slow cutoff and for the service's refusal (${q1.length}, ${q2.length})`);
        ok(!warned3.some((w) => w.includes("INTERNALQ")), "an internal reader's failed query is not logged as a buyer query");
        _resetCdpLogThrottleForTest();
      }
      console.warn = (m) => warned.push(String(m));
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
        seen.push({ health: isHealth(sql), sql, marked: !!init[Symbol.for("agent402.noOutcome")] });
        if (isHealth(sql)) return healthOk ? J(200, { result: [{ block_number: 1 }] }) : J(502, {});
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
        // The known-good query reads the buyer's table: a Base reading does
        // not vouch for Solana.
        healthOk = true; _setQueryHealthForTest(null); seen.length = 0;
        e = await sqlRun("SELECT count() FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY").catch((x) => x);
        ok(e?.statusCode === 422 && seen.find((s) => s.health)?.sql === QUERY_HEALTH_SQL.solana, `a Solana query's health read is on solana.instructions (${seen.find((s) => s.health)?.sql})`);
        _setQueryHealthForTest(true, "base"); _setQueryHealthForTest(null, "solana"); seen.length = 0; healthOk = false;
        e = await sqlRun("SELECT count() FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY").catch((x) => x);
        ok(e?.statusCode === 502 && seen.filter((s) => s.health).length === 1, "a healthy Base reading does not vouch for Solana: the Solana table is read on its own and its failure is a 502");
        // Slow failures that overlap share one health read (the read is held
        // 80 ms here so the second failure lands while it is in flight).
        healthOk = true; _setQueryHealthForTest(null); seen.length = 0;
        globalThis.fetch = async (url, init = {}) => {
          const sql = JSON.parse(init.body || "{}").sql;
          seen.push({ health: isHealth(sql), sql, marked: !!init[Symbol.for("agent402.noOutcome")] });
          if (isHealth(sql)) return new Promise((r) => setTimeout(() => r(J(200, { result: [{ block_number: 1 }] })), 80));
          return new Promise((r) => setTimeout(() => r(J(502, {})), seen.length === 1 ? 60 : 100));
        };
        await Promise.all([sqlRun().catch((x) => x), sqlRun().catch((x) => x)]);
        ok(seen.filter((s) => s.health).length === 1, `two overlapping slow failures share one health read (${seen.filter((s) => s.health).length})`);
        // The health read has its own short timeout: a hung service answers "unhealthy" within it.
        ok(HEALTH_TIMEOUT_MS === 5_000 && HEALTH_TTL_MS === 5 * 60_000, "the health read's timeout is 5 s and its reading is kept 5 minutes");
        _setHealthTimeoutMsForTest(150); _setQueryHealthForTest(null);
        globalThis.fetch = async (url, init = {}) => {
          const sql = JSON.parse(init.body || "{}").sql;
          if (isHealth(sql)) return new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true }); });
          return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
        };
        const tH = Date.now();
        const keepH = setInterval(() => {}, 1000); // a timeout signal alone does not hold the loop
        e = await sqlRun().catch((x) => x);
        clearInterval(keepH);
        ok(e?.statusCode === 502 && Date.now() - tH < 2000, `a hung health read ends at its own timeout and the failure stays a 502 (${Date.now() - tH} ms)`);
        _setHealthTimeoutMsForTest(null);
      } finally { globalThis.fetch = realFetchH; _setQueryHealthForTest(true); }
    }
    // At most two buyer queries run at once per server; a third is refused
    // at once, uncharged, with a retry time.
    {
      const realFetchC = globalThis.fetch;
      let release; const gate = new Promise((r) => { release = r; });
      globalThis.fetch = async () => { await gate; return J(200, { result: [{ x: 1 }] }); };
      try {
        const a = sqlRun(), b = sqlRun();
        await new Promise((r) => setTimeout(r, 20));
        ok(_buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX && BUYER_QUERY_INFLIGHT_MAX === 2, `two buyer queries are in flight (${_buyerQueriesInflightForTest()})`);
        const c = await Promise.race([sqlRun().catch((x) => x), new Promise((r) => setTimeout(() => r({ statusCode: "not refused" }), 500))]);
        ok(c?.statusCode === 429 && c?.retryAfter === 5 && c?.hint === "busy" && c?.shed === true, `a third is refused 429 with Retry-After 5, marked as shed load (${c?.statusCode})`);
        release();
        const [ra, rb] = await Promise.all([a, b]);
        ok(ra.rowCount === 1 && rb.rowCount === 1 && _buyerQueriesInflightForTest() === 0, "the two in flight answer and the count returns to zero");
      } finally { globalThis.fetch = realFetchC; }
    }
    // The log throttle: one line per key a minute, and its map is bounded.
    {
      const { _resetCdpLogThrottleForTest, _cdpLogOnceForTest } = await import("../src/tools/cdp-kit.js");
      _resetCdpLogThrottleForTest();
      const t0 = 1_700_000_000_000;
      ok(_cdpLogOnceForTest("k", t0) === true && _cdpLogOnceForTest("k", t0 + 59_000) === false && _cdpLogOnceForTest("k", t0 + 61_000) === true, "a key logs once a minute");
      for (let i = 0; i < 520; i++) _cdpLogOnceForTest(`shape-${i}`, t0);
      ok(_cdpLogThrottleSizeForTest() <= 501, `the throttle map stays bounded (${_cdpLogThrottleSizeForTest()})`);
      _resetCdpLogThrottleForTest();
    }
    // A 503 is the service unavailable: retried, then a plain upstream error, never "narrow it".
    calls = []; reply = () => J(503, {});
    e = await sqlRun().catch((x) => x);
    ok(e?.statusCode === 502 && !e?.hint && /retry shortly/.test(e.message) && !/narrow/i.test(e.message) && calls.length === 2, `a 503 is retried and answered as an upstream error to retry (attempts ${calls.length}, hint ${e?.hint})`);
    // A fast 500 is the result too large to send: the query is run once more
    // with the small row cap and those rows are served marked truncated, with the row
    // size and the LIMIT that fits.
    {
      const { SQL_RECOVER_ROWS, SQL_SEND_LIMIT_BYTES, SQL_RECOVER_ATTEMPTS } = await import("../src/tools/cdp-kit.js");
      // Measured 2026-11-03 against the query service on a 40 KB-per-row result: 25 rows (about 1 MB)
      // answered three runs in four, 10 rows every time in five; so the re-run asks for 10, twice at most,
      // and the suggested LIMIT keeps an answer under 500 KB.
      ok(SQL_RECOVER_ROWS === 10 && SQL_RECOVER_ATTEMPTS === 2 && SQL_SEND_LIMIT_BYTES === 500_000, "the recovery's cap, attempts and answer-size target are the measured ones");
      const sent = [];
      const realFetchR = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); calls.push({ url: String(url) }); return sent.length === 1 ? J(500, { errorMessage: "An internal server error occurred." }) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: `mint-${i}`, bals: "x".repeat(4000) })) }); };
      try {
        calls = [];
        const r = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m LIMIT 1000");
        ok(sent.length === 2 && new RegExp(`\\) LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[1]) && new RegExp(`GROUP BY m LIMIT 1000\\n\\) LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[1]), `the query is run once more with an outer LIMIT ${SQL_RECOVER_ROWS} (${sent[1]?.slice(-40)})`);
        ok(r.recovered === "result-size" && r.rowCount === SQL_RECOVER_ROWS && r.truncated === true && r.complete === false && r.matchedIsLowerBound === true && r.maxRows === SQL_RECOVER_ROWS, `the rows are served marked truncated and recovered (${r.rowCount} rows, recovered ${r.recovered})`);
        ok(r.rowBytes > 4000 && /about 4 KB/.test(r.note) && new RegExp(`a LIMIT of ${Math.floor(SQL_SEND_LIMIT_BYTES / r.rowBytes)} usually keeps`).test(r.note) && new RegExp(`an arbitrary ${SQL_RECOVER_ROWS} rows \\(it has no ORDER BY\\)`).test(r.note), `the note gives the row size, the LIMIT that fits and that the rows are arbitrary without ORDER BY (${r.note.slice(0, 160)})`);
        // With an ORDER BY the rows are the first ones; rowBytes counts UTF-8 bytes, not characters.
        sent.length = 0; calls = [];
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "\u{1F600}".repeat(10_000) })) }); };
        const ro = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m ORDER BY m LIMIT 1000");
        const { hasOuterOrderBy } = await import("../src/tools/cdp-kit.js");
        ok(hasOuterOrderBy("SELECT a FROM t ORDER BY a") && !hasOuterOrderBy("SELECT * FROM (SELECT a FROM t ORDER BY a) WHERE 1") && hasOuterOrderBy("SELECT * FROM (SELECT a FROM t) ORDER BY a LIMIT 5") && !hasOuterOrderBy("SELECT a FROM t WHERE x = 'order by'"), "only an ORDER BY outside every parenthesis orders the result");
        ok(/is usually sent/.test(ro.note) || /usually keeps/.test(ro.note), "the answer-size figure is stated as usual, not certain");
        ok(new RegExp(`its first ${SQL_RECOVER_ROWS} rows\\.`).test(ro.note) && ro.rowBytes >= 40_000 && new RegExp(`a LIMIT of ${Math.floor(SQL_SEND_LIMIT_BYTES / ro.rowBytes)} usually keeps`).test(ro.note), `an ordered query's rows are its first rows; a 40 KB UTF-8 row counts as 40 KB (${ro.rowBytes})`);
        // Fewer rows back than the cap: the whole result, served complete (the 500 was not about size).
        sent.length = 0; calls = [];
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { result: [{ m: 1 }, { m: 2 }, { m: 3 }] }); };
        const whole = await sqlRun("SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(whole.rowCount === 3 && whole.complete === true && whole.truncated === false && whole.recovered === undefined && !whole.note && sent.length === 2, `fewer than ${SQL_RECOVER_ROWS} rows back is the whole result, served complete (${whole.rowCount} rows, complete ${whole.complete})`);
        // Small rows: the 500 was a one-off, the original is sent once more and served whole.
        sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); if (sent.length === 1) return J(500, {}); if (new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(q)) return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i })) }); return J(200, { result: Array.from({ length: 400 }, (_, i) => ({ m: i })) }); };
        const small = await sqlRun("SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(small.rowCount === 400 && small.complete === true && small.recovered === undefined && sent.length === 3 && /LIMIT 1001$/.test(sent[2]), `small rows: the original is sent once more and served whole (${small.rowCount} rows, ${sent.length} calls)`);
        sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); if (new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(q)) return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i })) }); return J(500, {}); };
        const smallAgain = await sqlRun("SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(smallAgain.recovered === "result-size" && smallAgain.rowCount === SQL_RECOVER_ROWS && sent.length === 3, `small rows whose original fails again are served as the recovered 25 (${sent.length} calls)`);
        // The re-run gets one attempt: a 503 there is an upstream error, with no third query call.
        sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(503, {}); };
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && !e?.hint && sent.length === 2, `a 503 on the re-run is an upstream error after exactly two query calls (${e?.statusCode}, ${sent.length} calls)`);
        // A re-run body with no result list is an upstream error, never a charged empty answer.
        sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { nope: true }); };
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && /without a result list/.test(e.message), `a re-run answer with no result list is a 502 (${e?.statusCode})`);
        // Even the capped rows too large: 422 while the service answers a known-good query, else 502.
        sent.length = 0; calls = [];
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); calls.push({ url: String(url) }); return isHealth(q) ? J(200, { result: [{ block_slot: 1 }] }) : J(500, { errorMessage: "An internal server error occurred." }); };
        _setQueryHealthForTest(null);
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 422 && e?.hint === "narrow-query" && new RegExp(`Even ${SQL_RECOVER_ROWS} rows`).test(e.message) && sent.filter((q) => !isHealth(q)).length === 3, `when even ${SQL_RECOVER_ROWS} rows do not fit twice, a 422 says to select narrower columns (${e?.statusCode}, ${sent.filter((q) => !isHealth(q)).length} query calls: the original and two capped attempts)`);
        // The capped re-run gets a second attempt: a 500 then the capped rows is served.
        sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length <= 2 ? J(500, {}) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
        const second = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(second.recovered === "result-size" && second.rowCount === SQL_RECOVER_ROWS && sent.length === 3 && new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[1]) && new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[2]), `a capped re-run that fails once and answers on its second attempt is served (${sent.length} calls)`);
        _setQueryHealthForTest(false); sent.length = 0;
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return isHealth(q) ? J(200, { result: [{ block_slot: 1 }] }) : J(500, {}); };
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && /known-good query/.test(e.message), `with the service failing a known-good query too, it is a 502 (${e?.statusCode})`);
        _setQueryHealthForTest(true);
        // An unwrapped query (WITH) cannot take an outer cap: answered once, no resend.
        sent.length = 0; calls = [];
        e = await sqlRun("WITH t AS (SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY) SELECT * FROM t").catch((x) => x);
        ok(e?.statusCode === 502 && e?.hint === "narrow-query" && sent.length === 1, `a query sent unwrapped is answered once on an instant 500, not resent (${sent.length} call)`);
      } finally { globalThis.fetch = realFetchR; _setQueryHealthForTest(true); }
    }
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
    // A query already at the service's subquery depth cannot take the
    // wrapper (measured 2026-11-03: "subquery nesting too deep (max: 2)"), so
    // the cap goes in its own outer LIMIT.
    {
      const { cappedSql, subqueryDepth, SQL_NEST_MAX, SQL_MAX_ROWS, SQL_RECOVER_ROWS } = await import("../src/tools/cdp-kit.js");
      ok(SQL_NEST_MAX === 2, "the subquery depth the service allows is the measured one");
      const deep = "SELECT a FROM (SELECT b FROM (SELECT c FROM t))";
      ok(subqueryDepth("SELECT a FROM t") === 0 && subqueryDepth("SELECT a FROM (SELECT b FROM t)") === 1 && subqueryDepth(deep) === 2 && subqueryDepth("SELECT a FROM (SELECT b FROM ( WITH 1 AS k SELECT c FROM t))") === 2, "subquery depth counts each parenthesis that opens a SELECT or WITH");
      ok(subqueryDepth("SELECT a FROM (SELECT b FROM t WHERE x = '(select' /* (select */)") === 1 && subqueryDepth("SELECT a, (SELECT 1) FROM t") === 1, "a subquery marker inside a string or a comment is not a subquery; one in the select list is");
      const c = cappedSql(deep + " LIMIT 60000");
      ok(c.capped === true && c.lineOffset === 0 && c.sql === deep + ` LIMIT ${SQL_MAX_ROWS + 1}` && c.limitTo(SQL_RECOVER_ROWS) === deep + ` LIMIT ${SQL_RECOVER_ROWS}`, "at the depth limit the query's own outer LIMIT is lowered to the cap, and the recovery cap goes there too");
      ok(cappedSql(deep).sql === deep + `\nLIMIT ${SQL_MAX_ROWS + 1}` && cappedSql(deep + " LIMIT 3 BY a").sql === deep + ` LIMIT 3 BY a\nLIMIT ${SQL_MAX_ROWS + 1}`, "without an outer LIMIT (a LIMIT n BY is a per-group cap) one is appended");
      ok(cappedSql(deep + " LIMIT 10, 5000").sql === deep + ` LIMIT 10, ${SQL_MAX_ROWS + 1}` && cappedSql(deep + " LIMIT 5 OFFSET 10").sql === deep + " LIMIT 5 OFFSET 10" && cappedSql(deep + " ORDER BY a LIMIT 2000 WITH TIES").sql === deep + ` ORDER BY a LIMIT ${SQL_MAX_ROWS + 1} WITH TIES`, "LIMIT m, n lowers n; a LIMIT under the cap is kept; OFFSET and WITH TIES stay");
      ok(cappedSql(deep + " limit 7000; -- end").sql === deep + ` limit ${SQL_MAX_ROWS + 1}` && cappedSql("SELECT a FROM (SELECT b FROM (SELECT c FROM t LIMIT 5)) LIMIT 9000").sql.endsWith("LIMIT 5)) LIMIT 1001"), "the case is kept, a trailing semicolon dropped, and a LIMIT inside a subquery is not the outer one");
      const u = cappedSql(deep + " UNION ALL SELECT 1");
      ok(u.capped === false && u.sql === deep + " UNION ALL SELECT 1" && u.limitTo === null, "at the depth limit a UNION outside every parenthesis has no outer LIMIT to lower: sent as written");
      ok(cappedSql("SELECT a FROM (SELECT b FROM t)", { wrap: false }).sql === "SELECT a FROM (SELECT b FROM t)\nLIMIT 1001" && cappedSql("SELECT a FROM t").lineOffset === 1, "the wrapper can be turned off by the caller; a wrapped query reports its one-line offset");
      const realFetchN = globalThis.fetch;
      let sent = [];
      const rowsOf = (n) => J(200, { result: Array.from({ length: n }, (_, i) => ({ i })) });
      try {
        // The deep query is sent with its LIMIT lowered, never wrapped; a
        // full cap's worth of rows back still reads as cut.
        globalThis.fetch = async (url, init = {}) => { sent.push(JSON.parse(init.body || "{}").sql); return rowsOf(SQL_MAX_ROWS + 1); };
        const r = await sqlRun(deep + " LIMIT 60000");
        ok(sent.length === 1 && sent[0] === deep + ` LIMIT ${SQL_MAX_ROWS + 1}` && r.rows.length === SQL_MAX_ROWS && r.truncated === true && r.matchedIsLowerBound === true, `a query at the depth limit is sent unwrapped with its LIMIT lowered and a cut result is marked (${sent.length} call)`);
        // A subquery the depth reader did not see: the service's own refusal
        // of the wrapper sends the query once more with the cap in its LIMIT.
        sent = [];
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return /^SELECT \* FROM \(/.test(q) ? J(400, { errorMessage: "SQL validation failed: subquery nesting too deep (max: 2) (position start: 1, position end: 2)" }) : rowsOf(3); };
        const f = await sqlRun("SELECT a FROM (SELECT b FROM t) LIMIT 50").catch((x) => x);
        ok(!(f instanceof Error) && sent.length === 2 && /^SELECT \* FROM \(/.test(sent[0]) && sent[1] === "SELECT a FROM (SELECT b FROM t) LIMIT 50" && f.rowCount === 3 && f.complete === true, `a nesting refusal of the wrapper is answered by the query under its own LIMIT (${sent.length} calls${f instanceof Error ? `, ${f.statusCode}` : ""})`);
        // The same refusal of an unwrapped query is the buyer's, answered once.
        sent = [];
        globalThis.fetch = async (url, init = {}) => { sent.push(JSON.parse(init.body || "{}").sql); return J(400, { errorMessage: "SQL validation failed: subquery nesting too deep (max: 2)" }); };
        const g = await sqlRun(deep + " LIMIT 5").catch((x) => x);
        ok(g?.statusCode === 422 && sent.length === 1, `a nesting refusal of an unwrapped query is the buyer's (${g?.statusCode}, ${sent.length} call)`);
        // The result-size recovery re-runs the deep query under LIMIT 10 in
        // its own LIMIT, not wrapped.
        sent = [];
        globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
        const rec = await sqlRun(deep + " LIMIT 60000");
        ok(rec.recovered === "result-size" && sent.length === 2 && sent[1] === deep + ` LIMIT ${SQL_RECOVER_ROWS}`, `the recovery of a query at the depth limit lowers its own LIMIT (${sent.length} calls)`);
        // A syntax error the service places by line is named on the query as
        // written: one line up for a wrapped query, as is for an unwrapped one.
        globalThis.fetch = async () => J(400, { errorMessage: "invalid syntax at line 3, column 0" });
        const w = await sqlRun("SELECT a FROM t\nWHERE").catch((x) => x);
        const n = await sqlRun(deep + "\nWHERE").catch((x) => x);
        ok(w?.statusCode === 422 && /at line 2, column 0/.test(w.message) && n?.statusCode === 422 && /at line 3, column 0/.test(n.message), `a line in the service's refusal is the buyer's line (wrapped: "${w?.message?.slice(-30)}", unwrapped: "${n?.message?.slice(-30)}")`);
      } finally { globalThis.fetch = realFetchN; }
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
      ok(solanaRangeRefusal("SELECT block_time, tx_id FROM solana.instructions WHERE tx_signer = 'x'") !== null && solanaRangeRefusal("SELECT x AS block_time FROM solana.instructions WHERE a = 1") !== null && solanaRangeRefusal("SELECT a FROM solana.instructions WHERE a = 1 ORDER BY block_time") !== null, "block_time selected, aliased or ordered by is not a range");
      ok(solanaRangeRefusal("SELECT multiIf(a = 1, 'x', 'y'), nullIf(a, 0) FROM solana.instructions LIMIT 10") === null, "a scalar conditional (multiIf, nullIf) is not an aggregate");
      ok(solanaRangeRefusal("SELECT a FROM solana.instructions PREWHERE tx_signer = 'a'") !== null && solanaRangeRefusal("SELECT countIf(a = 1) FROM solana.instructions") !== null && solanaRangeRefusal("SELECT a FROM solana.instructions LIMIT 1 BY a") !== null && solanaRangeRefusal("SELECT stddevPop(a) FROM solana.instructions") !== null, "PREWHERE, -If combinators, LIMIT BY and the stddev family are read as scans");
      ok(solanaRangeRefusal("SELECT a FROM solana . instructions WHERE a = 1") !== null && solanaRangeRefusal("SELECT `a'b` FROM solana.instructions WHERE a = 1") !== null && solanaRangeRefusal("SELECT \"c--d\" FROM solana.instructions WHERE a = 1") !== null, "spaces around the dot and quotes inside identifiers do not hide the table or the clause");
      ok(solanaRangeRefusal("SELECT a FROM solana.instructions WHERE block_time = '2026-11-01'") === null, "an equality on block_time is a bound");
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
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time >= toDateTime('2026-10-01 00:00:00')", at) === 33 && blockTimeRangeDays("SELECT 1 WHERE block_time >= toDate('2026-10-31')", at) === 3 && blockTimeRangeDays("SELECT 1 WHERE '2026-10-30' <= block_time", at) === 4, "toDateTime and toDate literals and a reversed comparison are read; one bound spans to now");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time >= '2026-10-08' AND block_time < '2026-10-01'", at) === null, "reversed bounds read no range (never a negative span)");
      { const t0 = Date.now(); for (let i = 0; i < 10; i++) blockTimeRangeDays("SELECT 1 WHERE block_time >= now ( ) - interval 1 " + "a".repeat(9_900), at); ok(Date.now() - t0 < 200, `the range reader stays fast on a 10 KB adversarial query (${Date.now() - t0} ms for 10 reads)`); }
      { const { cappedSql: capQ } = await import("../src/tools/cdp-kit.js"); const bad10k = "SELECT '" + "\\'".repeat(4_995); const t0 = Date.now(); for (let i = 0; i < 10; i++) { capQ(bad10k); solanaRangeRefusal(bad10k); sqlNorm(bad10k); } ok(Date.now() - t0 < 100, `an unclosed string of escaped quotes stays linear through every mask (${Date.now() - t0} ms for 30 passes)`); }
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > subtractDays(now(), 3)", at) === 3 && blockTimeRangeDays("SELECT 1 WHERE block_time > today() - 5", at) === 5, "subtractDays and today() - N are read");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > someFunc(x)", at) === null && blockTimeRangeDays("SELECT 1 WHERE tx_signer = 'x'", at) === null, "a bound this reader does not know, or no block_time, reads no range");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - toIntervalDay(7)", at) === null, "an expression that continues past a known bound (now() - toIntervalDay(7)) reads no range, never zero");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 1 DAY OR block_time > '2020-01-01'", at) === null && blockTimeRangeDays("SELECT 1 WHERE a = 1 OR block_time > '2026-10-01'", at) === null && blockTimeRangeDays("SELECT 1 WHERE '2026-10-01' <= block_time OR a = 1", at) === null && blockTimeRangeDays("SELECT 1 WHERE block_time BETWEEN '2026-10-01' AND '2026-10-08' OR a = 1", at) === null && blockTimeRangeDays("SELECT 1 WHERE block_time >= '2026-10-01' AND block_time < '2026-10-03' OR a = 1", at) === null, "an OR anywhere reads no range, whichever reader found the bound");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 1 DAY AND tx_signer = 'x or y' -- or not", at) === 1, "an OR inside a string or a comment is not an OR");
      ok(blockTimeRangeDays("SELECT 1 WHERE block_time > now() - INTERVAL 3 DAY AND x = 1", at) === 3 && blockTimeRangeDays("SELECT 1 WHERE (block_time > now() - INTERVAL 2 DAY)", at) === 2, "a bound followed by AND or a closing parenthesis still reads");
      { calls = []; reply = () => new Promise((r) => setTimeout(() => r(J(502, {})), 60)); const h = await tool("onchain-sql").handler({ sql: "SELECT count() FROM solana.instructions WHERE block_time > now() - INTERVAL 6 HOUR" }).catch((x) => x); ok(/covers about 6 hours/.test(h?.message || ""), `a sub-day span is named in hours (${String(h?.message).match(/covers about [^;]*/)?.[0]})`); }
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
