// CDP kit — offline unit tests. No network, no real keys: verifies the JWT
// minting against locally generated EC + Ed25519 keypairs (signature must
// cryptographically verify; claims must match the CDP contract), the input
// validation of all three handlers, the env gate (503 without keys), and the
// faucet's local rate gate.
//
//   node scripts/test-cdp-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { leastOurs } from "./lib/ours-clock.js";
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
ok(CDP_TOOLS.length === 6, "kit exports 6 tools");
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
await rejects(() => tool("onchain-sql").handler({ sql: "SELECT " + "x,".repeat(31000) + "y FROM base.events" }), 400, "onchain-sql over-length → 400");
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
    ok(e?.statusCode === 503 && e?.attribution === "ours" && /^Coinbase Developer Platform did not answer the faucet read within our 15 s limit/.test(e.message) && calls.length === 1,
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
    const { _setSlowQueryGatewayMsForTest, _setQueryHealthForTest, QUERY_HEALTH_SQL, _setHealthTimeoutMsForTest, HEALTH_TIMEOUT_MS, HEALTH_TTL_MS, HEALTH_UNKNOWN_TTL_MS, _ageQueryHealthForTest = () => {}, BUYER_QUERY_INFLIGHT_MAX, BUYER_QUERY_INFLIGHT_DEFAULT, _buyerQueriesInflightForTest, _cdpLogThrottleSizeForTest, _resetSqlPacerForTest, sqlSendGapMs, takeSqlSendSlot } = await import("../src/tools/cdp-kit.js");
    _resetSqlPacerForTest(0); // the send pacer has its own section below
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
        // The lines are bounded by bytes a minute: distinct large queries
        // past the budget log a head with the length and hash, whole again
        // the next minute.
        {
          const { FAILED_QUERY_LOG_BYTES_PER_MIN, _resetFailedQueryLogBudgetForTest } = await import("../src/tools/cdp-kit.js");
          _resetFailedQueryLogBudgetForTest(); _resetCdpLogThrottleForTest();
          const warned4 = []; console.warn = (m) => warned4.push(String(m));
          calls = []; reply = () => J(400, { errorMessage: "Query scanned more data than the per-query limit allows" });
          const bigQ = (i) => "SELECT block_number FROM base.blocks WHERE block_time > 1 /* " + "p".repeat(50_000) + " */ -- " + i;
          const n = Math.ceil(FAILED_QUERY_LOG_BYTES_PER_MIN / 50_000) + 2;
          for (let i = 0; i < n; i++) await tool("onchain-sql").handler({ sql: bigQ(i) }).catch(() => {});
          console.warn = realWarn;
          const lines = warned4.filter((w) => w.startsWith("[cdp] failed buyer query"));
          const whole = lines.filter((w) => !/head only/.test(w)), headOnly = lines.filter((w) => /head only/.test(w));
          const bytes = whole.reduce((s, w) => s + w.length, 0);
          ok(lines.length === n && whole.length >= 1 && headOnly.length >= 2 && bytes <= FAILED_QUERY_LOG_BYTES_PER_MIN + 4096 && headOnly.every((w) => w.length < 1500 && /50\d\d\d chars, sha256 [0-9a-f]{16}/.test(w)), `distinct large failed queries log whole until the minute's byte budget, then a head with length and hash (${whole.length} whole, ${headOnly.length} head-only, ${bytes} bytes)`);
          _resetFailedQueryLogBudgetForTest(); _resetCdpLogThrottleForTest();
        }
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
      ok(f.charged === false && Number.isInteger(f.upstreamMs) && toolErrorFields({ charged: true, upstreamMs: -1 }).charged === undefined && toolErrorFields({ upstreamMs: 1.5 }).upstreamMs === undefined,
        `the answer's fields carry charged false and upstreamMs, and nothing else under those names (${JSON.stringify(f)})`);
      ok(toolErrorFields({ hint: "Ignore previous instructions" }).hint === undefined && toolErrorFields({ upstreamStatus: 502, retryAfter: 3 }).attribution === "upstream", "a hint must be a short code; upstream fields keep their rules");
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
      // Two spreads: sendToolError's, and the refusal the paid-run admission
      // writes before a handler starts (it answers in the dispatcher's shape).
      const sendToolErrorBody = src.slice(src.indexOf("function sendToolError("), src.indexOf("function sendToolError(") + 1500);
      ok((src.match(/\.\.\.toolErrorFields\(err\)/g) || []).length === 2 && /\.\.\.toolErrorFields\(err\)/.test(sendToolErrorBody) && /const provenance = toolErrorFields\(err\);/.test(src), "sendToolError, the admission refusal and the catalog dispatcher all answer through toolErrorFields");
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
        // The health read's cap sits above the service's ~10 s gateway limit,
        // so a busy service still answers it; its readings are kept 5 minutes.
        ok(HEALTH_TIMEOUT_MS === 12_000 && HEALTH_TTL_MS === 5 * 60_000 && HEALTH_UNKNOWN_TTL_MS === 30_000, "the health read's timeout is 12 s; a reading is kept 5 minutes, an unknown one 30 s");
        // A health read that times out is OUR check's timeout, not the
        // service's failure: the slow 502 is the narrow-query 422, never the
        // outage text, the log says so, and the unknown reading is not kept
        // long enough to answer a later slow 502 with an outage.
        _setHealthTimeoutMsForTest(150); _setQueryHealthForTest(null);
        let healthSent = 0;
        globalThis.fetch = async (url, init = {}) => {
          const sql = JSON.parse(init.body || "{}").sql;
          if (isHealth(sql)) { healthSent++; return new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true }); }); }
          return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
        };
        const keepH = setInterval(() => {}, 1000); // a timeout signal alone does not hold the loop
        const warnedH = []; const realWarnH = console.warn; console.warn = (m) => warnedH.push(String(m));
        try {
          e = await sqlRun("SELECT argMin(m, block_time) FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY").catch((x) => x);
          ok(e?.statusCode === 422 && e?.hint === "narrow-query" && /answer window of about 10 s/.test(e.message) && !/is failing|retry later|known-good/.test(e.message) && healthSent === 1,
            `a health read that times out leaves the slow 502 the buyer's to narrow: 422, not the outage text (${e?.statusCode} ${String(e?.message).slice(0, 70)}; ${healthSent} health read)`);
          const hLine = warnedH.find((w) => /query health/.test(w)) || "";
          ok(/timed out after \d+ ms; verdict unknown \(a timeout of our check, not a failure of the service\)/.test(hLine) && !warnedH.some((w) => /did not answer within/.test(w)), `the log names a timeout of our check, not a failure of the service (${hLine.slice(0, 120)})`);
          // A burst inside the unknown window sends no further health read.
          for (let i = 0; i < 4; i++) {
            e = await sqlRun("SELECT argMin(m, block_time) FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY").catch((x) => x);
            if (e?.statusCode !== 422) break;
          }
          ok(e?.statusCode === 422 && healthSent === 1, `a burst of slow 502s after a timed-out health read shares its unknown reading: one health read in all (${healthSent}), each a 422 (${e?.statusCode})`);
          // A minute later the unknown reading has lapsed: the check runs
          // again, and while it still times out the answer is again the 422.
          _ageQueryHealthForTest(60_000);
          e = await sqlRun("SELECT argMin(m, block_time) FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY").catch((x) => x);
          ok(e?.statusCode === 422 && !/is failing|retry later/.test(e.message) && healthSent === 2, `a slow 502 a minute later is not answered from a kept outage verdict: a fresh check (${healthSent} health reads), a 422 (${e?.statusCode})`);
          // A known-good query the service answers with a 5xx is an outage.
          _setQueryHealthForTest(null);
          globalThis.fetch = async (url, init = {}) => {
            const sql = JSON.parse(init.body || "{}").sql;
            if (isHealth(sql)) return J(503, {});
            return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
          };
          e = await sqlRun().catch((x) => x);
          ok(e?.statusCode === 502 && /is failing/.test(e.message) && /known-good query failed too/.test(e.message), `a known-good query answered 503 keeps the outage text (${e?.statusCode})`);
          ok(warnedH.some((w) => /query health: the known-good base query answered HTTP 503: the query service is failing/.test(w)), "the log names the service's own failure on the known-good query");
          // ONE 5xx on the known-good query speaks for a minute, not five: the
          // service recovers, and 61 s later a slow 502 is read afresh (the
          // 422), while 30 s later the kept outage reading still answers.
          {
            const { HEALTH_FAILING_TTL_MS } = await import("../src/tools/cdp-kit.js");
            ok(HEALTH_FAILING_TTL_MS === 60_000, `a "failing" reading is kept 60 s (${HEALTH_FAILING_TTL_MS})`);
            let hs = 0;
            globalThis.fetch = async (url, init = {}) => {
              const sql = JSON.parse(init.body || "{}").sql;
              if (isHealth(sql)) { hs++; return J(200, { result: [{ block_number: 1 }] }); }
              return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
            };
            _ageQueryHealthForTest(30_000);
            e = await sqlRun().catch((x) => x);
            ok(e?.statusCode === 502 && /is failing/.test(e.message) && hs === 0, `30 s after a failing read the outage reading still answers (${e?.statusCode}, ${hs} health reads)`);
            _ageQueryHealthForTest(31_000);
            e = await sqlRun().catch((x) => x);
            ok(e?.statusCode === 422 && e?.hint === "narrow-query" && hs === 1, `61 s after one failing read the service is read again and its recovery is believed (${e?.statusCode}, ${hs} health reads)`);
            // A REAL OUTAGE stays reported: every re-read fails, every buyer is told.
            _setQueryHealthForTest(null);
            globalThis.fetch = async (url, init = {}) => {
              const sql = JSON.parse(init.body || "{}").sql;
              if (isHealth(sql)) { hs++; return J(503, {}); }
              return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
            };
            let reported = 0;
            for (let i = 0; i < 4; i++) { e = await sqlRun().catch((x) => x); if (e?.statusCode === 502 && /is failing/.test(e.message)) reported++; _ageQueryHealthForTest(61_000); }
            ok(reported === 4, `a sustained outage is reported to every buyer across re-reads (${reported} of 4)`);
          }
          // A refused health read (no answer at all) is unknown too.
          _setQueryHealthForTest(null);
          globalThis.fetch = async (url, init = {}) => {
            const sql = JSON.parse(init.body || "{}").sql;
            if (isHealth(sql)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
            return new Promise((r) => setTimeout(() => r(J(502, {})), 60));
          };
          e = await sqlRun().catch((x) => x);
          ok(e?.statusCode === 422 && e?.hint === "narrow-query", `a health read that cannot reach the host is unknown: the 422 (${e?.statusCode})`);
        } finally { console.warn = realWarnH; clearInterval(keepH); }
        _setHealthTimeoutMsForTest(null);
      } finally { globalThis.fetch = realFetchH; _setQueryHealthForTest(true); }
    }
    // At most BUYER_QUERY_INFLIGHT_MAX buyer queries run at once per server
    // (8 by default); the next is refused at once, uncharged, with a retry time.
    {
      const realFetchC = globalThis.fetch;
      let release; const gate = new Promise((r) => { release = r; });
      globalThis.fetch = async () => { await gate; return J(200, { result: [{ x: 1 }] }); };
      try {
        ok(BUYER_QUERY_INFLIGHT_DEFAULT === 8 && BUYER_QUERY_INFLIGHT_MAX === 8, `the in-flight cap is 8 by default (${BUYER_QUERY_INFLIGHT_MAX})`);
        const held = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => sqlRun());
        await new Promise((r) => setTimeout(r, 20));
        ok(_buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX, `${BUYER_QUERY_INFLIGHT_MAX} buyer queries are in flight (${_buyerQueriesInflightForTest()})`);
        // The next waits for a place as far out as a send slot may be (here
        // the handler budget leaves one second), then is refused.
        process.env.UPSTREAM_HANDLER_BUDGET_MS = "2500";
        const c = await sqlRun().catch((x) => x);
        delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
        ok(c?.statusCode === 429 && c?.retryAfter >= 4 && c?.retryAfter <= 6 && c?.hint === "busy" && c?.shed === true && /answering 8 queries/.test(c?.message) && /Nothing was charged\.$/.test(c?.message), `the next, with no place free within its reach, is refused 429 with Retry-After 4 to 6 s, marked as shed load (${c?.statusCode}, ${c?.retryAfter})`);
        // This server's own read (the economy snapshot) at the cap: it is
        // not refused by the cap and takes no buyer's place in it.
        const { ownSqlQuery } = await import("../src/tools/cdp-kit.js");
        const own = ownSqlQuery({ sql: "SELECT block_number FROM base.blocks" });
        const ownEarly = await Promise.race([own.then(() => "answered", (x) => x), new Promise((r) => setTimeout(() => r("in flight"), 60))]);
        ok(ownEarly === "in flight" && _buyerQueriesInflightForTest() === BUYER_QUERY_INFLIGHT_MAX, `an own read at the cap is not refused and is not counted as a buyer's query (${ownEarly?.statusCode ?? ownEarly}, ${_buyerQueriesInflightForTest()} counted)`);
        release();
        const done = await Promise.all(held);
        ok(done.every((r) => r.rowCount === 1) && _buyerQueriesInflightForTest() === 0, "the ones in flight answer and the count returns to zero");
        ok((await own).rowCount === 1 && _buyerQueriesInflightForTest() === 0, "the own read answers and the count stays at zero");
        // Own reads in flight leave every buyer place free.
        {
          let free; const wait = new Promise((r) => { free = r; });
          globalThis.fetch = async () => { await wait; return J(200, { result: [{ x: 1 }] }); };
          const owns = Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => ownSqlQuery({ sql: "SELECT block_number FROM base.blocks" }));
          await new Promise((r) => setTimeout(r, 20));
          const buyer = sqlRun();
          await new Promise((r) => setTimeout(r, 20));
          ok(_buyerQueriesInflightForTest() === 1, `with ${BUYER_QUERY_INFLIGHT_MAX} own reads in flight a buyer's query still takes a place (${_buyerQueriesInflightForTest()} counted)`);
          free();
          const all = await Promise.all([buyer, ...owns].map((p) => p.catch((x) => x)));
          ok(all.every((r) => r.rowCount === 1) && _buyerQueriesInflightForTest() === 0, "and all of them answer");
        }
        // A caller's own third argument is not the mark: it is counted as a buyer's query.
        {
          let free; const wait = new Promise((r) => { free = r; });
          globalThis.fetch = async () => { await wait; return J(200, { result: [{ x: 1 }] }); };
          const forged = tool("onchain-sql").handler({ sql: "SELECT block_number FROM base.blocks" }, { own: true }, "own sql read");
          await new Promise((r) => setTimeout(r, 20));
          ok(_buyerQueriesInflightForTest() === 1, "a call that passes its own mark is counted as a buyer's query");
          free(); await forged;
        }
      } finally { globalThis.fetch = realFetchC; }
    }
    // ONCHAIN_SQL_INFLIGHT_MAX overrides the cap inside 1..16; anything else keeps 8.
    {
      const { execFileSync } = await import("node:child_process");
      const capWith = (v) => Number(execFileSync(process.execPath, ["--input-type=module", "-e", `import("${new URL("../src/tools/cdp-kit.js", import.meta.url).href}").then((m) => console.log(m.BUYER_QUERY_INFLIGHT_MAX))`], { env: { ...process.env, ONCHAIN_SQL_INFLIGHT_MAX: v }, encoding: "utf8" }).trim().split("\n").pop());
      ok(capWith("3") === 3 && capWith("16") === 16 && capWith("0") === 8 && capWith("17") === 8 && capWith("2.5") === 8 && capWith("x") === 8, "ONCHAIN_SQL_INFLIGHT_MAX sets the cap within 1..16 only");
    }
    // The send pacer: slots CDP_SQL_SEND_GAP_MS apart (625 ms default, times
    // the replicas), so a raised in-flight cap never raises the send rate.
    {
      const { sqlSendGapConfig, sqlSendGapWarnings, SQL_SLOT_WAIT_MS, SQL_SLOT_WAIT_SLOTS, sqlSlotWaitMs, SQL_SEND_GAP_MAX_MS, _setSqlPacerClockForTest } = await import("../src/tools/cdp-kit.js");
      ok(sqlSendGapMs({}) === 625 && sqlSendGapMs({ RATE_LIMIT_REPLICAS: "2" }) === 1250 && sqlSendGapMs({ CDP_SQL_SEND_GAP_MS: "50" }) === 625 && sqlSendGapMs({ CDP_SQL_SEND_GAP_MS: "1000" }) === 1000,
        "the send gap is 625 ms per replica by default, overridable from 100 ms");
      // A send waits for its slot up to 3 s or four gaps, whichever is
      // longer: at one replica the 3 s it always had, at more replicas the
      // same four slots out, so a wider gap never leaves a query fewer sends
      // ahead of it. Every later send of a call (a retry, a recovery run) is
      // one gap behind its own first send, always in reach.
      ok(SQL_SLOT_WAIT_MS === 3_000 && SQL_SLOT_WAIT_SLOTS === 4 && sqlSlotWaitMs(625) === 3_000 && sqlSlotWaitMs(1250) === 5_000 && sqlSlotWaitMs(SQL_SEND_GAP_MAX_MS) === 10_000,
        `a send waits for its slot up to 3 s or four gaps (${[625, 1250, SQL_SEND_GAP_MAX_MS].map((g) => `${sqlSlotWaitMs(g)} ms at ${g}`).join(", ")})`);
      // The gap in force is held at 2.5 s whatever the knob and the replica
      // count are set to, so a send never waits more than four such gaps.
      const wide = [{ RATE_LIMIT_REPLICAS: "5" }, { RATE_LIMIT_REPLICAS: "1000" }, { CDP_SQL_SEND_GAP_MS: "5000" }, { CDP_SQL_SEND_GAP_MS: "60000" }, { CDP_SQL_SEND_GAP_MS: "60001" }, { CDP_SQL_SEND_GAP_MS: "1000", RATE_LIMIT_REPLICAS: "3" }, { CDP_SQL_SEND_GAP_MS: "2500", RATE_LIMIT_REPLICAS: "2" }];
      ok(SQL_SEND_GAP_MAX_MS === 2_500 && wide.every((env) => sqlSendGapMs(env) === SQL_SEND_GAP_MAX_MS) && sqlSendGapMs({ CDP_SQL_SEND_GAP_MS: "2500" }) === 2_500 && sqlSendGapMs({ RATE_LIMIT_REPLICAS: "4" }) === 2_500,
        `a gap past ${SQL_SEND_GAP_MAX_MS} ms, set by the knob, the replicas or both, is held there (${wide.map((env) => sqlSendGapMs(env)).join(", ")})`);
      const namesOf = (env) => sqlSendGapConfig(env).rejected.map((r) => r.name).join(" + ");
      ok(namesOf({}) === "" && namesOf({ CDP_SQL_SEND_GAP_MS: "1000", RATE_LIMIT_REPLICAS: "2" }) === "" && namesOf({ CDP_SQL_SEND_GAP_MS: "50" }) === "CDP_SQL_SEND_GAP_MS" && namesOf({ CDP_SQL_SEND_GAP_MS: "1.5e2x" }) === "CDP_SQL_SEND_GAP_MS"
        && namesOf({ CDP_SQL_SEND_GAP_MS: "5000" }) === "CDP_SQL_SEND_GAP_MS" && namesOf({ RATE_LIMIT_REPLICAS: "5" }) === "RATE_LIMIT_REPLICAS" && namesOf({ CDP_SQL_SEND_GAP_MS: "1000", RATE_LIMIT_REPLICAS: "3" }) === "CDP_SQL_SEND_GAP_MS times RATE_LIMIT_REPLICAS"
        && namesOf({ CDP_SQL_SEND_GAP_MS: "x", RATE_LIMIT_REPLICAS: "9" }) === "CDP_SQL_SEND_GAP_MS + RATE_LIMIT_REPLICAS",
        "a value not taken as set is reported by the name of its setting; values in range report nothing");
      const warned = sqlSendGapWarnings({ CDP_SQL_SEND_GAP_MS: "59999" });
      ok(warned.length === 1 && /^\[cdp\] the send gap set by CDP_SQL_SEND_GAP_MS is past 2500 ms/.test(warned[0]) && /sent 2500 ms apart$/.test(warned[0]) && !warned[0].includes("59999") && sqlSendGapWarnings({}).length === 0,
        `the line names the setting and the gap in force, never the value (${warned[0]})`);
      // At boot: the module prints that line once when it loads with such a value, and nothing otherwise.
      {
        const { spawnSync } = await import("node:child_process");
        const bootLines = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", `await import("${new URL("../src/tools/cdp-kit.js", import.meta.url).href}")`], { env: { ...process.env, CDP_SQL_SEND_GAP_MS: "", RATE_LIMIT_REPLICAS: "", ...env }, encoding: "utf8" }).stderr.split("\n").filter((l) => l.startsWith("[cdp] "));
        const over = bootLines({ CDP_SQL_SEND_GAP_MS: "59999", RATE_LIMIT_REPLICAS: "2" });
        const bad = bootLines({ CDP_SQL_SEND_GAP_MS: "12" });
        ok(over.length === 1 && /CDP_SQL_SEND_GAP_MS times RATE_LIMIT_REPLICAS/.test(over[0]) && !over[0].includes("59999") && bad.length === 1 && /^\[cdp\] CDP_SQL_SEND_GAP_MS is not a whole number/.test(bad[0]) && /sent 625 ms apart$/.test(bad[0]) && bootLines({}).length === 0 && bootLines({ CDP_SQL_SEND_GAP_MS: "800", RATE_LIMIT_REPLICAS: "2" }).length === 0,
          `a boot with a rejected value logs its setting's name once; a boot with usable values logs nothing (${over[0]})`);
      }
      const realFetchP = globalThis.fetch;
      // A clock the test owns: `slots` are the times the pacer scheduled a
      // wait to end, read as numbers, not as timer firings on a busy machine.
      const T0 = 1_000_000;
      const clockOf = (advance) => { const c = { t: T0, slots: [] }; c.now = () => c.t; c.sleep = async (ms) => { c.slots.push(c.t + ms); if (advance) c.t += ms; }; return c; };
      let clock = clockOf(false);
      const sentAt = [];
      globalThis.fetch = async () => { sentAt.push(clock.now()); return J(200, { result: [{ x: 1 }] }); };
      try {
        // At one replica two sends go back to back (the burst of two, its own
        // section in scripts/test-onchain-sql-pacer.js): four at once are two
        // pairs, two gaps apart. With one gap per send (more replicas), a
        // slot apart.
        _setSqlPacerClockForTest(clock);
        _resetSqlPacerForTest(150, 2);
        const rs = await Promise.all([sqlRun(), sqlRun(), sqlRun(), sqlRun()]);
        ok(rs.every((r) => r.rowCount === 1) && sentAt.length === 4 && clock.slots.join() === [300, 300].map((d) => T0 + d).join(), `four queries at once are scheduled as two pairs two gaps apart (the first pair at once, then +${clock.slots.map((s) => s - T0).join(", +")} ms)`);
        clock = clockOf(false); _setSqlPacerClockForTest(clock);
        _resetSqlPacerForTest(150, 1);
        sentAt.length = 0;
        await Promise.all([sqlRun(), sqlRun(), sqlRun(), sqlRun()]);
        ok(sentAt.length === 4 && clock.slots.join() === [150, 300, 450].map((d) => T0 + d).join(), `with one gap per send, four at once are scheduled a slot apart (+${clock.slots.map((s) => s - T0).join(", +")} ms)`);
        // The same on the real clock, read as a span from before the calls
        // began (a floor that load cannot lower): the fourth is sent no sooner
        // than two gaps later.
        _setSqlPacerClockForTest(null);
        _resetSqlPacerForTest(150, 2);
        const realSent = [];
        globalThis.fetch = async () => { realSent.push(Date.now()); return J(200, { result: [{ x: 1 }] }); };
        const began = Date.now();
        await Promise.all([sqlRun(), sqlRun(), sqlRun(), sqlRun()]);
        ok(realSent.length === 4 && Math.max(...realSent) - began >= 2 * 150 - 5, `on the real clock the fourth of four is sent two gaps after the calls began or later (${Math.max(...realSent) - began} ms)`);
        // A send waits for its slot as many slots out as 3 s holds at the
        // default gap (four), at any gap in force: at two replicas (one gap
        // per send) five queries at once are each sent, the fifth four gaps
        // out (5 s, past the flat 3 s), and a sixth, with no send slot in
        // reach, is the busy refusal: nothing is sent. At one replica (pairs)
        // six are sent, the last pair four gaps out, and the seventh is refused.
        globalThis.fetch = async () => { sentAt.push(clock.now()); return J(200, { result: [{ x: 1 }] }); };
        for (const replicas of ["1", "2"]) {
          const { gapMs: gap, burst } = sqlSendGapConfig({ RATE_LIMIT_REPLICAS: replicas });
          const waits = burst === 2 ? [2, 2, 4, 4] : [1, 2, 3, 4];
          const fit = waits.length + 1 + (burst === 2 ? 1 : 0);
          clock = clockOf(false); _setSqlPacerClockForTest(clock);
          _resetSqlPacerForTest(gap, burst);
          sentAt.length = 0;
          const sent = await Promise.all(Array.from({ length: fit }, () => sqlRun().catch((x) => x)));
          const next = await sqlRun().catch((x) => x);
          ok(sent.every((r) => r?.rowCount === 1) && clock.slots.join() === waits.map((k) => T0 + k * gap).join() && sentAt.length === fit,
            `at ${replicas} replica(s) (gap ${gap} ms, ${burst} back to back) ${fit} queries at once are all sent, the last ${4 * gap} ms out (${sent.map((r) => r?.statusCode ?? 200).join(", ")})`);
          ok(next?.statusCode === 429 && next?.hint === "busy" && next?.shed === true && /rate limit allows/.test(next?.message) && /Nothing was charged\.$/.test(next?.message) && sentAt.length === fit && clock.slots.length === waits.length && _buyerQueriesInflightForTest() === 0,
            `at ${replicas} replica(s) the next, with no send slot in reach, is refused 429 busy, unsent, and its in-flight place returned (${next?.statusCode}, sent ${sentAt.length})`);
        }
        // The mechanics below are read with one gap per send (the rule at
        // more than one replica); the burst of two has its own section.
        // This server's own read takes a send slot only when no other query
        // is waiting for one: right after a send it waits out the one gap
        // (its own reads run one after another), and behind a query that is
        // waiting for its slot it is refused (429, its caller tries again
        // later), unsent, and the next buyer gets the slot it would have had.
        {
          const { ownSqlQuery } = await import("../src/tools/cdp-kit.js");
          clock = clockOf(false); _setSqlPacerClockForTest(clock);
          _resetSqlPacerForTest(625, 1);
          sentAt.length = 0;
          const ownRead = () => ownSqlQuery({ sql: "SELECT block_number FROM base.blocks" }).catch((x) => x);
          const own1 = await ownRead();
          ok(own1?.rowCount === 1 && sentAt.length === 1 && clock.slots.length === 0, `an own read with a slot free is sent at once (${own1?.statusCode ?? 200})`);
          const own2 = await ownRead();
          ok(own2?.rowCount === 1 && sentAt.length === 2 && clock.slots.join() === String(T0 + 625), `an own read right after a send, with no query waiting, waits the one gap and is sent (${own2?.statusCode ?? 200}, slot +${clock.slots.map((s) => s - T0).join(", +")} ms)`);
          await sqlRun(); // a buyer's query takes the next slot: until it is sent, it is waiting
          const own3 = await ownRead();
          const buyer = await sqlRun();
          ok(own3?.statusCode === 429 && sentAt.length === 4 && buyer?.rowCount === 1 && clock.slots.join() === [625, 1250, 1875].map((d) => T0 + d).join() && _buyerQueriesInflightForTest() === 0,
            `an own read behind a query waiting for its slot is refused unsent, and the buyer after it takes the slot it would have had (${own3?.statusCode}, slots +${clock.slots.map((s) => s - T0).join(", +")} ms)`);
        }
        // A buyer whose connection closes while its query waits for its slot:
        // the query is not sent (nothing to deliver, so nothing is charged:
        // the 499 cancels settlement), and its in-flight place is returned.
        {
          clock = clockOf(false); _setSqlPacerClockForTest(clock);
          _resetSqlPacerForTest(625, 1);
          sentAt.length = 0;
          await sqlRun(); // the next slot is one gap off
          const req = {};
          const sleep = clock.sleep;
          _setSqlPacerClockForTest({ now: clock.now, sleep: async (ms) => { await sleep(ms); req.__a402ClientGoneAt = Date.now(); } }); // the buyer leaves during the wait
          const gone = await tool("onchain-sql").handler({ sql: "SELECT block_number FROM base.blocks" }, req).catch((x) => x);
          _setSqlPacerClockForTest(clock);
          ok(gone?.statusCode === 499 && sentAt.length === 1 && _buyerQueriesInflightForTest() === 0, `a buyer who left while its query waited for its slot: the query is not sent, 499, place returned (${gone?.statusCode}, sent ${sentAt.length})`);
          const stays = await tool("onchain-sql").handler({ sql: "SELECT block_number FROM base.blocks" }, {}).catch((x) => x);
          ok(stays?.rowCount === 1 && sentAt.length === 2, "control: a buyer still connected after its wait is sent and served");
        }
        // A later send of the same call (the retry of a fast 5xx, a recovery run) waits for its slot,
        // also at the widest gap the settings can give; the clock here moves by each wait.
        clock = clockOf(true); _setSqlPacerClockForTest(clock);
        _resetSqlPacerForTest(sqlSendGapMs({ CDP_SQL_SEND_GAP_MS: "60000", RATE_LIMIT_REPLICAS: "4" }), 1);
        sentAt.length = 0;
        globalThis.fetch = async () => { sentAt.push(clock.now()); return J(500, {}); };
        const r3 = await sqlRun().catch((x) => x);
        const g3 = sentAt.slice(1).map((t, i) => t - sentAt[i]);
        ok(r3?.statusCode >= 400 && r3?.statusCode !== 429 && sentAt.length >= 2 && g3.every((g) => g === SQL_SEND_GAP_MAX_MS), `at the widest gap the settings give, a later send of the call waits for its slot and is sent (${r3?.statusCode}, gaps ${g3.join(", ")} ms)`);
        // A later send whose slot is out of reach (four sends of other calls
        // queued ahead of it, at the widest gap) is not sent: the call ends on
        // what it has, uncharged.
        {
          clock = clockOf(false); _setSqlPacerClockForTest(clock);
          _resetSqlPacerForTest(SQL_SEND_GAP_MAX_MS, 1);
          sentAt.length = 0;
          let first = true;
          globalThis.fetch = async () => {
            sentAt.push(clock.now());
            if (first) { first = false; await Promise.all(Array.from({ length: 4 }, () => sqlRun())); return J(503, {}); } // four others take the next slots
            return J(200, { result: [{ x: 1 }] });
          };
          const r4 = await sqlRun().catch((x) => x);
          ok(r4?.statusCode === 502 && /unavailable/.test(r4?.message) && sentAt.length === 5 && clock.slots.length === 4 && _buyerQueriesInflightForTest() === 0,
            `a retry whose slot is out of reach is not sent; the call ends on its 5xx (${r4?.statusCode}, sent ${sentAt.length})`);
        }
        // takeSqlSendSlot itself: no slot taken when refused.
        _setSqlPacerClockForTest(null);
        _resetSqlPacerForTest(1_000, 1);
        const t0 = 1_000_000;
        ok(await takeSqlSendSlot(0, t0) === true && await takeSqlSendSlot(500, t0) === false && await takeSqlSendSlot(1_000, t0 + 2_000) === true,
          "a refused slot is not taken: the next caller gets the same slot");
      } finally { _setSqlPacerClockForTest(null); globalThis.fetch = realFetchP; _resetSqlPacerForTest(0); }
    }
    // The pacer is all a send waits on. Nothing in src/ marks a facilitator
    // call for queries to wait behind: no module names such a mark, the kit
    // and the facilitator config export none, and a facilitator client is
    // registered as built (scripts/test-onchain-sql-paid-path.js holds the
    // paid path to it on a booted server).
    {
      const { readFileSync, readdirSync } = await import("node:fs");
      const srcDir = new URL("../src/", import.meta.url);
      const sources = readdirSync(srcDir, { recursive: true }).filter((f) => String(f).endsWith(".js")).map((f) => ({ f: String(f), text: readFileSync(new URL(String(f), srcDir), "utf8") }));
      const MARK = /prioritizeCdpCalls|beginPriorityCdpCall|yieldToSettlement|priority(?:Inflight|ClearAt|Waiters)|_priorityLaneForTest|__cdpPriority|settlement lane/;
      const naming = sources.filter((s) => MARK.test(s.text)).map((s) => s.f);
      const kitNow = await import("../src/tools/cdp-kit.js");
      const facNow = await import("../src/cdp-facilitator.js");
      ok(sources.length > 100 && naming.length === 0, `no module in src/ names a mark that holds queries behind facilitator calls (${naming.join(", ") || "none"})`);
      ok(!Object.keys(kitNow).some((k) => /priority|settlement/i.test(k)) && Object.keys(facNow).sort().join() === "CDP_FACILITATOR_HOST,CDP_FACILITATOR_ROUTE,CDP_FACILITATOR_URL,cdpAuthHeaders,cdpCorrelationHeader,cdpFacilitatorConfig",
        `the kit and the facilitator config export no such mark (${Object.keys(facNow).sort().join(", ")})`);
      const pay = sources.find((s) => s.f === "payments.js").text;
      const wiring = (name) => new RegExp(`const ${name} = \\([^\\n]*\\) => \\{\\n(?:\\s*//[^\\n]*\\n)*\\s*labelFacilitatorErrors\\(`).exec(pay);
      ok(!!wiring("addFacilitator") && !!wiring("wireSideFacilitator") && !/client\.(?:verify|settle) = /.test(pay.slice(pay.indexOf("const addFacilitator = "), pay.indexOf("const wireSideFacilitator = ") + 600).replace(/labelFacilitatorErrors[^\n]*/g, "")),
        "each facilitator client the server registers goes straight to its error labels: nothing wraps its verify or settle for the query pacer first");
    }
    // A 2xx from the query service whose body cannot be read (cut off, empty,
    // not JSON, or stalled past the read limit) is an uncharged 502 to retry,
    // never a complete result with no rows; a real answer with no rows is
    // served. The call's in-flight place is returned and the pacer's next
    // slot is one gap after that send, as after any other.
    {
      const { _setCdpReadMsForTest, _setSqlPacerClockForTest } = await import("../src/tools/cdp-kit.js");
      const realFetchU = globalThis.fetch;
      const T0 = 2_000_000;
      const text200 = (text, type = "application/json") => new Response(text, { status: 200, headers: { "content-type": type } });
      // A body that starts and then fails: at once (a reset mid-body), or when the read's own limit aborts it (a stall).
      const brokenBody = (init, { stall }) => new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"result":[{"x":1},'));
          if (!stall) return c.error(new TypeError("terminated"));
          init.signal?.addEventListener("abort", () => c.error(init.signal.reason), { once: true });
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
      const cases = [
        ["a truncated JSON body", () => text200('{"result":[{"x":1},{"x":')],
        ["an empty body", () => text200("")],
        ["an HTML page", () => text200("<html><body><h1>502 Bad Gateway</h1></body></html>", "text/html")],
        ["a body reset part way", (init) => brokenBody(init, { stall: false })],
        ["a body that stalls past the read limit", (init) => brokenBody(init, { stall: true })],
      ];
      const keepU = setInterval(() => {}, 1000); // a timeout signal alone does not hold the loop
      try {
        _setCdpReadMsForTest(150);
        for (const [name, respond] of cases) {
          const clock = { t: T0, slots: [] }; clock.now = () => clock.t; clock.sleep = async (ms) => { clock.slots.push(clock.t + ms); };
          _setSqlPacerClockForTest(clock); _resetSqlPacerForTest(150, 1);
          let sentN = 0;
          globalThis.fetch = async (url, init = {}) => { sentN++; return respond(init); };
          const e = await sqlRun().catch((x) => x);
          ok(e?.statusCode === 502 && /answer could not be read \(cut off, empty or not JSON\); retry shortly\. Nothing was charged\.$/.test(e?.message || "") && !e?.hint && sentN === 1,
            `${name} in a 200 is a 502 to retry, never an empty result, and is not sent again (${e?.statusCode ?? `200 with ${e?.rowCount} rows`}, ${sentN} sent)`);
          globalThis.fetch = async () => { sentN++; return J(200, { result: [{ x: 1 }] }); };
          const next = await sqlRun().catch((x) => x);
          ok(_buyerQueriesInflightForTest() === 0 && next?.rowCount === 1 && clock.slots.join() === String(T0 + 150), `${name}: the in-flight place is returned and the next query takes the next slot, one gap on (${_buyerQueriesInflightForTest()} in flight, slot +${clock.slots.map((s) => s - T0).join()} ms)`);
        }
        _setSqlPacerClockForTest(null); _resetSqlPacerForTest(0);
        // More unreadable answers than the cap, at once: every place comes back.
        globalThis.fetch = async () => text200('{"result":[');
        const many = await Promise.all(Array.from({ length: BUYER_QUERY_INFLIGHT_MAX }, () => sqlRun().catch((x) => x)));
        globalThis.fetch = async () => J(200, { result: [{ x: 1 }] });
        const after = await sqlRun().catch((x) => x);
        ok(many.every((x) => x?.statusCode === 502) && _buyerQueriesInflightForTest() === 0 && after?.rowCount === 1, `${BUYER_QUERY_INFLIGHT_MAX} unreadable answers at once return all ${BUYER_QUERY_INFLIGHT_MAX} places (${_buyerQueriesInflightForTest()} in flight after)`);
        // Real answers are served as before: no rows, one row, and a JSON body without a list.
        globalThis.fetch = async () => J(200, { result: [] });
        const zero = await sqlRun();
        ok(zero.rowCount === 0 && Array.isArray(zero.rows) && zero.rows.length === 0 && zero.complete === true && zero.truncated === false && !("raw" in zero), `a real answer with no rows is served as a complete empty result (${JSON.stringify(zero)})`);
        globalThis.fetch = async () => J(200, { result: [{ x: 1 }] });
        const one = await sqlRun();
        ok(one.rowCount === 1 && one.rows[0].x === 1 && one.complete === true, "a real answer with one row is served");
        globalThis.fetch = async () => J(200, { result: null });
        const noList = await sqlRun();
        ok(noList.rowCount === 0 && "raw" in noList, "a JSON answer without a list is served as before, with the service's body under raw");
        // The schema read: the same rule.
        const schema = () => tool("onchain-sql-schema").handler({});
        globalThis.fetch = async () => text200('{"tables":[{"name":"base.ev');
        const se = await schema().catch((x) => x);
        globalThis.fetch = async () => text200("");
        const se2 = await schema().catch((x) => x);
        globalThis.fetch = async () => J(200, { "base.events": [{ name: "block_number", type: "UInt64" }] });
        const sv = await schema();
        ok(se?.statusCode === 502 && /could not be read/.test(se.message) && se2?.statusCode === 502 && sv.schema?.["base.events"]?.[0]?.name === "block_number", `an unreadable schema answer is a 502, never an empty schema; a real one is served (${se?.statusCode}, ${se2?.statusCode})`);
        // Another CDP read keeps its own handling of a 200 it cannot parse.
        globalThis.fetch = async () => text200("");
        const wb = await bal().catch((x) => x);
        ok(wb?.count === 0, `only the query service's two reads take the rule (a balances read of an empty 200 answers as before: ${wb?.statusCode ?? `count ${wb?.count}`})`);
      } finally { clearInterval(keepU); _setCdpReadMsForTest(null); _setSqlPacerClockForTest(null); globalThis.fetch = realFetchU; _resetSqlPacerForTest(0); }
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
      const { SQL_RECOVER_ROWS, SQL_SEND_LIMIT_BYTES, SQL_QUERY_BUDGET } = await import("../src/tools/cdp-kit.js");
      // Measured 2026-11-03 against the query service on a 40 KB-per-row result: 25 rows (about 1 MB)
      // answered three runs in four, 10 rows every time in five; so the re-run asks for 10, again while
      // the call's query budget holds, and the suggested LIMIT keeps an answer under 500 KB.
      ok(SQL_RECOVER_ROWS === 10 && SQL_QUERY_BUDGET === 3 && SQL_SEND_LIMIT_BYTES === 500_000, "the recovery's cap, the call's query budget and the answer-size target are the measured ones");
      const sent = [];
      const realFetchR = globalThis.fetch;
      // The row-size measure the recovery now makes first (one aggregate
      // over the query) is answered here with no row over the limit, so these
      // cases keep exercising the re-run path; the row-size path has its own
      // cases below.
      const isMeasure = (q) => /countIf\(length\(toString\(tuple\(\*\)\)\)/.test(String(q || ""));
      const withMeasureShim = (stub) => async (url, init = {}) => (isMeasure(JSON.parse(init.body || "{}").sql) ? J(200, { result: [{ n: 0, big: 0, maxRow: 1 }] }) : stub(url, init));
      globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); calls.push({ url: String(url) }); return sent.length === 1 ? J(500, { errorMessage: "An internal server error occurred." }) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: `mint-${i}`, bals: "x".repeat(4000) })) }); });
      try {
        calls = [];
        const r = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m LIMIT 1000");
        ok(sent.length === 2 && new RegExp(`\\) LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[1]) && new RegExp(`GROUP BY m LIMIT 1000\\n\\) LIMIT ${SQL_RECOVER_ROWS}$`).test(sent[1]), `the query is run once more with an outer LIMIT ${SQL_RECOVER_ROWS} (${sent[1]?.slice(-40)})`);
        ok(r.recovered === "result-size" && r.rowCount === SQL_RECOVER_ROWS && r.truncated === true && r.complete === false && r.matchedIsLowerBound === true && r.maxRows === SQL_RECOVER_ROWS, `the rows are served marked truncated and recovered (${r.rowCount} rows, recovered ${r.recovered})`);
        ok(r.rowBytes > 4000 && /about 4 KB/.test(r.note) && new RegExp(`a LIMIT of ${Math.floor(SQL_SEND_LIMIT_BYTES / r.rowBytes)} usually keeps`).test(r.note) && new RegExp(`an arbitrary ${SQL_RECOVER_ROWS} rows \\(it has no ORDER BY\\)`).test(r.note), `the note gives the row size, the LIMIT that fits and that the rows are arbitrary without ORDER BY (${r.note.slice(0, 160)})`);
        // With an ORDER BY the rows are the first ones; rowBytes counts UTF-8 bytes, not characters.
        sent.length = 0; calls = [];
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "\u{1F600}".repeat(10_000) })) }); });
        const ro = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m ORDER BY m LIMIT 1000");
        const { hasOuterOrderBy } = await import("../src/tools/cdp-kit.js");
        ok(hasOuterOrderBy("SELECT a FROM t ORDER BY a") && !hasOuterOrderBy("SELECT * FROM (SELECT a FROM t ORDER BY a) WHERE 1") && hasOuterOrderBy("SELECT * FROM (SELECT a FROM t) ORDER BY a LIMIT 5") && !hasOuterOrderBy("SELECT a FROM t WHERE x = 'order by'"), "only an ORDER BY outside every parenthesis orders the result");
        ok(/is usually sent/.test(ro.note) || /usually keeps/.test(ro.note), "the answer-size figure is stated as usual, not certain");
        ok(new RegExp(`its first ${SQL_RECOVER_ROWS} rows\\.`).test(ro.note) && ro.rowBytes >= 40_000 && new RegExp(`a LIMIT of ${Math.floor(SQL_SEND_LIMIT_BYTES / ro.rowBytes)} usually keeps`).test(ro.note), `an ordered query's rows are its first rows; a 40 KB UTF-8 row counts as 40 KB (${ro.rowBytes})`);
        // Fewer rows back than the cap: the whole result, served complete (the 500 was not about size).
        sent.length = 0; calls = [];
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { result: [{ m: 1 }, { m: 2 }, { m: 3 }] }); });
        const whole = await sqlRun("SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(whole.rowCount === 3 && whole.complete === true && whole.truncated === false && whole.recovered === undefined && !whole.note && sent.length === 2, `fewer than ${SQL_RECOVER_ROWS} rows back is the whole result, served complete (${whole.rowCount} rows, complete ${whole.complete})`);
        // Small rows: the 500 was not the result's size, but the call's query
        // budget (the query, the row-size measure, the capped re-run) is
        // spent, so the original is never resent: the 10 rows are served
        // marked truncated, the note names the budget, and it never calls the
        // error a one-off or asks for the same query again.
        sent.length = 0;
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); if (sent.length === 1) return J(500, {}); if (new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(q)) return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i })) }); throw new Error("the original is never resent past the budget"); });
        const small = await sqlRun("SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m");
        ok(small.rowCount === SQL_RECOVER_ROWS && small.truncated === true && small.complete === false && small.recovered === "result-size" && small.resent === undefined && sent.length === 2 && new RegExp(`query budget of ${SQL_QUERY_BUDGET} queries`).test(small.note) && !/one-off|send the query again as written/.test(small.note), `small rows with the budget spent: ${SQL_RECOVER_ROWS} rows truncated, no resend, the note names the budget (${small.rowCount} rows, ${sent.length} calls)`);
        // The re-run gets one attempt: a 503 there is an upstream error, with no third query call.
        sent.length = 0;
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(503, {}); });
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && !e?.hint && sent.length === 2, `a 503 on the re-run is an upstream error after exactly two query calls (${e?.statusCode}, ${sent.length} calls)`);
        // A re-run body with no result list is an upstream error, never a charged empty answer.
        sent.length = 0;
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return sent.length === 1 ? J(500, {}) : J(200, { nope: true }); });
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && /without a result list/.test(e.message), `a re-run answer with no result list is a 502 (${e?.statusCode})`);
        // Even the capped rows too large: 422 while the service answers a known-good query, else 502.
        sent.length = 0; calls = [];
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); calls.push({ url: String(url) }); return isHealth(q) ? J(200, { result: [{ block_slot: 1 }] }) : J(500, { errorMessage: "An internal server error occurred." }); });
        _setQueryHealthForTest(null);
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 422 && e?.hint === "narrow-query" && new RegExp(`Even ${SQL_RECOVER_ROWS} rows`).test(e.message) && sent.filter((q) => !isHealth(q)).length === 2, `when even ${SQL_RECOVER_ROWS} rows do not fit, a 422 says to select narrower columns (${e?.statusCode}, ${sent.filter((q) => !isHealth(q)).length} query calls: the original and one capped attempt inside the budget)`);
        // The capped re-run gets one attempt inside the budget: a 500 there
        // is the uncharged narrow-query 422, never a fourth query.
        sent.length = 0;
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); if (isHealth(q)) return J(200, { result: [{ block_slot: 1 }] }); return sent.length <= 2 ? J(500, {}) : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); });
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 422 && e?.hint === "narrow-query" && sent.filter((q) => !isHealth(q)).length === 2, `a capped re-run that fails once is the 422, with no second attempt past the budget (${e?.statusCode}, ${sent.filter((q) => !isHealth(q)).length} calls)`);
        _setQueryHealthForTest(false); sent.length = 0;
        globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); return isHealth(q) ? J(200, { result: [{ block_slot: 1 }] }) : J(500, {}); });
        e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
        ok(e?.statusCode === 502 && /known-good query/.test(e.message), `with the service failing a known-good query too, it is a 502 (${e?.statusCode})`);
        // Our check timing out is not the service failing: the 422.
        _setQueryHealthForTest(null); _setHealthTimeoutMsForTest(150); sent.length = 0;
        {
          const keepR = setInterval(() => {}, 1000);
          globalThis.fetch = withMeasureShim(async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sent.push(q); if (isHealth(q)) return new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true }); }); return J(500, {}); });
          e = await sqlRun("SELECT m, bals FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY m").catch((x) => x);
          clearInterval(keepR);
          ok(e?.statusCode === 422 && e?.hint === "narrow-query" && !/is failing|retry later/.test(e.message) && sent.filter(isHealth).length === 1, `when our health read times out, even ${SQL_RECOVER_ROWS} rows not fitting is the 422, not the outage text (${e?.statusCode} ${String(e?.message).slice(0, 60)})`);
        }
        _setHealthTimeoutMsForTest(null);
        _setQueryHealthForTest(true);
        // An unwrapped query (WITH) cannot take an outer cap: answered once, no resend.
        sent.length = 0; calls = [];
        e = await sqlRun("WITH t AS (SELECT m FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY) SELECT * FROM t").catch((x) => x);
        ok(e?.statusCode === 502 && e?.hint === "narrow-query" && sent.length === 1, `a query sent unwrapped is answered once on an instant 500, not resent (${sent.length} call)`);
        // The row-size path: a row over the service's per-row limit is the
        // cause; the rows that fit are served with the omitted ones counted.
        {
          const { SQL_ROW_LIMIT_BYTES, SQL_ROW_FILTER_CHARS, SQL_MAX_ROWS } = await import("../src/tools/cdp-kit.js");
          ok(SQL_ROW_LIMIT_BYTES === 65_536 && SQL_ROW_FILTER_CHARS === 64_000, "the per-row limit and the filter threshold are the measured ones");
          const sentR = [];
          const fitRows = Array.from({ length: 18 }, (_, i) => ({ ix: i + 2, sk: "x".repeat(100) }));
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, { errorMessage: "An internal server error occurred." }); if (isMeasure(q)) return J(200, { result: [{ n: 22, big: 4, maxRow: 65972 }] }); return J(200, { result: fitRows }); };
          const r = await sqlRun("SELECT ix, sk FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY GROUP BY ix, sk");
          ok(r.recovered === "row-size" && r.rowsOmitted === 4 && r.omittedReason === "row-size" && r.rowCount === 18 && r.complete === false && r.truncated === true && r.matched === 22 && r.rowLimitBytes === 65_536 && r.maxRowBytes === 65972 && /4 row\(s\).*64 KB per-row limit.*about 64 KB.*18 rows that fit/.test(r.note), `rows over the per-row limit are omitted and counted, the rest served (${r.rowCount} served, ${r.rowsOmitted} omitted, matched ${r.matched})`);
          ok(sentR.length === 3 && isMeasure(sentR[1]) && /^SELECT count\(\) AS n, countIf/.test(sentR[1]) && /WHERE length\(toString\(tuple\(\*\)\)\) <= 64000 LIMIT 1001$/.test(sentR[2]) && /^SELECT \* FROM \(\n/.test(sentR[2]), `the measure is one aggregate and the rows that fit are one filtered run (${sentR.length} calls)`);
          // A filtered result past the cap is cut and reads as a lower bound.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(200, { result: [{ n: 5000, big: 2, maxRow: 70000 }] }); return J(200, { result: Array.from({ length: SQL_MAX_ROWS + 1 }, (_, i) => ({ i })) }); };
          const c = await sqlRun("SELECT i FROM base.blocks");
          ok(c.recovered === "row-size" && c.rowCount === SQL_MAX_ROWS && c.truncated === true && c.complete === false && c.cutAt === undefined && c.countsFromSeparateRun === undefined && c.matched === 5000 && c.rowsOmitted === 2 && /about 68 KB/.test(c.note), `a filtered result past the cap is cut at ${SQL_MAX_ROWS} and marked (${c.rowCount}, truncated ${c.truncated})`);
          ok(r.truncated === true && r.complete === false && r.matched === 22 && r.returned === 18 && r.cutAt === undefined && r.countsFromSeparateRun === undefined && !/separate run/.test(r.note), "an answer with omitted rows reads incomplete and truncated by the shared rule, with the exact match count");
          // The measure and the serving run disagree (a query with no ORDER BY):
          // the match count is never below served plus omitted, and the answer
          // says the counts came from a separate run.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(200, { result: [{ n: 5, big: 4 }] }); return J(200, { result: fitRows }); };
          const two = await sqlRun("SELECT ix, sk FROM solana.instructions WHERE block_time > now() - INTERVAL 1 DAY");
          ok(two.recovered === "row-size" && two.matched === 22 && two.returned === 18 && two.rowsOmitted === 4 && two.complete === false && two.truncated === true && two.countsFromSeparateRun === true && /separate run/.test(two.note) && two.maxRowBytes === null && !/about NaN/.test(two.note) && /limit \(array and map/.test(two.note), `a measure that disagrees with the serving run never reads complete, is marked, and a missing maxRow leaves the note whole (matched ${two.matched}, complete ${two.complete}, marked ${two.countsFromSeparateRun})`);
          // A refusal of the rewritten measure or filter is never logged as
          // the buyer's failed query; the buyer's own instant 500 still is.
          sentR.length = 0;
          { const warnedR = []; const realWarnR = console.warn; console.warn = (m) => warnedR.push(String(m));
            globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(400, { errorMessage: "ROWSIZEMEASURE refused" }); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
            const lg = await sqlRun("SELECT i, 'ROWSIZEBUYER' AS t FROM base.blocks");
            console.warn = realWarnR;
            const fails = warnedR.filter((w) => w.includes("failed buyer query"));
            ok(lg.recovered === "result-size" && fails.length === 1 && fails[0].includes("ROWSIZEBUYER") && !fails.some((w) => w.includes("countIf(")), `the rewritten measure's refusal is not logged as a failed buyer query, the buyer's own 500 is (${fails.length} line, rewritten logged ${fails.some((w) => w.includes("countIf("))})`);
          }
          // Every matching row over the limit: nothing to serve, so the re-run
          // path and its uncharged 422, never an empty 200.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (isMeasure(q)) return J(200, { result: [{ n: 1, big: 1, maxRow: 70000 }] }); if (/WHERE length\(toString/.test(q)) return J(200, { result: [] }); return isHealth(q) ? J(200, { result: [{ block_number: 1 }] }) : J(500, {}); };
          const empty = await sqlRun("SELECT * FROM base.transactions WHERE hash = '0xabc'").catch((x) => x);
          ok(empty?.statusCode === 422 && empty?.hint === "narrow-query" && sentR.filter((q) => !isHealth(q)).length === SQL_QUERY_BUDGET, `every row over the limit is the uncharged narrow-query 422, not an empty 200 (${empty?.statusCode}, ${sentR.filter((q) => !isHealth(q)).length} query calls)`);
          // The call's query budget: the worst path (the query, the measure
          // finding big rows, the filtered run failing) is exactly
          // SQL_QUERY_BUDGET queries and the uncharged narrow-query 422 that
          // names the budget; a fourth query is never sent.
          {
            const { _maxQueriesPerCallForTest } = await import("../src/tools/cdp-kit.js");
            const budgeted = (answer) => async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; if (isHealth(q)) return J(200, { result: [{ block_number: 1 }] }); sentR.push(q); if (sentR.length > SQL_QUERY_BUDGET) throw new Error(`query ${sentR.length} sent past the budget`); return answer(q, sentR.length); };
            const label = (q) => (isMeasure(q) ? "measure" : /WHERE length\(toString/.test(q) ? "filter" : /LIMIT 10$/.test(q) ? "small" : "query");
            sentR.length = 0;
            globalThis.fetch = budgeted((q) => (isMeasure(q) ? J(200, { result: [{ n: 50, big: 3, maxRow: 70000 }] }) : J(500, { errorMessage: "An internal server error occurred." })));
            const worst = await sqlRun("SELECT i FROM base.blocks").catch((x) => x);
            ok(worst?.statusCode === 422 && worst?.hint === "narrow-query" && worst?.queryBudgetSpent === true && new RegExp(`inside the ${SQL_QUERY_BUDGET} queries a call may send`).test(worst.message) && sentR.length === SQL_QUERY_BUDGET && sentR.length === 3 && isMeasure(sentR[1]) && /WHERE length\(toString/.test(sentR[2]),
              `worst path: the query, the measure and the filtered run are exactly ${SQL_QUERY_BUDGET} queries, then the uncharged 422 (${worst?.statusCode}, ${sentR.length} queries: ${sentR.map(label).join(", ")})`);
            // A fast 5xx on the query is retried once and that retry is a
            // query: the measure then spends the budget, and neither the
            // filtered run nor the small re-run is sent.
            sentR.length = 0;
            globalThis.fetch = budgeted((q, n) => (n === 1 ? J(502, {}) : isMeasure(q) ? J(200, { result: [{ n: 50, big: 3, maxRow: 70000 }] }) : J(500, {})));
            const retried = await sqlRun("SELECT i FROM base.blocks").catch((x) => x);
            ok(retried?.statusCode === 422 && retried?.queryBudgetSpent === true && new RegExp(`inside the ${SQL_QUERY_BUDGET} queries a call may send`).test(retried.message) && sentR.length === SQL_QUERY_BUDGET && !sentR.some((q) => new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(q)),
              `a retried query spends the budget too: no small re-run past it, and the 422 names the budget (${retried?.statusCode}, ${sentR.length} queries)`);
            // The row-size path is the whole budget: the query, the measure, the filtered run.
            sentR.length = 0;
            globalThis.fetch = budgeted((q, n) => (n === 1 ? J(500, {}) : isMeasure(q) ? J(200, { result: [{ n: 22, big: 4, maxRow: 65972 }] }) : J(200, { result: fitRows })));
            const rowSize = await sqlRun("SELECT ix, sk FROM base.blocks");
            ok(rowSize.recovered === "row-size" && rowSize.rowCount === 18 && sentR.length === 3, `the row-size path is three queries (${sentR.length})`);
            // The result-size path is the whole budget too: the query, a
            // measure finding no big row (or refused), the small re-run.
            for (const [lab, measure] of [["no big row", J(200, { result: [{ n: 400, big: 0, maxRow: 3000 }] })], ["measure refused", J(400, { errorMessage: "refused" })]]) {
              sentR.length = 0;
              globalThis.fetch = budgeted((q, n) => (n === 1 ? J(500, {}) : isMeasure(q) ? measure : J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) })));
              const rs = await sqlRun("SELECT i FROM base.blocks");
              ok(rs.recovered === "result-size" && rs.rowCount === SQL_RECOVER_ROWS && sentR.length === 3 && new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(sentR[2]), `the result-size path (${lab}) is three queries with no resend (${sentR.length})`);
            }
            // Small rows (the result's size was not the cause): no query is
            // left for a resend, so the rows are served truncated with a note
            // naming the budget, never a one-off and never "send it again".
            const tinyRows = Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i }));
            const noBig = () => J(200, { result: [{ n: 400, big: 0, maxRow: 30 }] });
            const isSmall = (q) => new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(q);
            sentR.length = 0;
            globalThis.fetch = budgeted((q, n) => (n === 1 ? J(500, {}) : isMeasure(q) ? noBig() : isSmall(q) ? J(200, { result: tinyRows }) : J(200, { result: [] })));
            const spent = await sqlRun("SELECT i FROM base.blocks");
            ok(spent.recovered === "result-size" && spent.rowCount === SQL_RECOVER_ROWS && spent.truncated === true && spent.resent === undefined && new RegExp(`query budget of ${SQL_QUERY_BUDGET} queries left no room`).test(spent.note) && !/one-off|twice|send the query again/.test(spent.note) && sentR.length === SQL_QUERY_BUDGET && isSmall(sentR[2]),
              `small rows with the budget spent: the truncated rows with a note naming the budget, no resend (${sentR.length} queries)`);
            // The small re-run gets one try inside the budget: a 500 there is
            // the 422 that says even 10 rows could not be sent.
            sentR.length = 0;
            globalThis.fetch = budgeted((q) => (isMeasure(q) ? J(200, { result: [{ n: 400, big: 0, maxRow: 3000 }] }) : J(500, {})));
            const once = await sqlRun("SELECT i FROM base.blocks").catch((x) => x);
            ok(once?.statusCode === 422 && new RegExp(`^Even ${SQL_RECOVER_ROWS} rows of this query could not be sent`).test(once.message) && !/times/.test(once.message) && sentR.length === SQL_QUERY_BUDGET, `a small re-run that fails inside the budget is the 422 (${sentR.length} queries)`);
            // Every shape the handler can send, failing at every step, stays inside the budget.
            for (const shape of ["SELECT i FROM base.blocks", "SELECT a FROM (SELECT b FROM (SELECT c FROM base.blocks)) LIMIT 60000", "WITH t AS (SELECT i FROM base.blocks) SELECT * FROM t", "SELECT a FROM (SELECT b FROM base.blocks) LIMIT 50"]) {
              for (const measure of [J(200, { result: [{ n: 50, big: 3, maxRow: 70000 }] }), J(200, { result: [{ n: 50, big: 0, maxRow: 100 }] }), J(400, { errorMessage: "SQL validation failed: subquery nesting too deep (max: 2)" })]) {
                sentR.length = 0;
                globalThis.fetch = budgeted((q, n) => (isMeasure(q) ? measure : /^SELECT \* FROM \(/.test(q) && n === 1 ? J(400, { errorMessage: "SQL validation failed: subquery nesting too deep (max: 2)" }) : J(500, {})));
                const r = await sqlRun(shape).catch((x) => x);
                ok(r instanceof Error && sentR.length <= SQL_QUERY_BUDGET, `a call failing at every step sends at most ${SQL_QUERY_BUDGET} queries (${sentR.length} for "${shape.slice(0, 30)}")`);
              }
            }
            ok(_maxQueriesPerCallForTest() === SQL_QUERY_BUDGET, `no call in this suite sent more than the budget (most sent: ${_maxQueriesPerCallForTest()})`);
          }
          // A refusal of the rewritten filtered SQL is not the buyer's to read.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(200, { result: [{ n: 9, big: 1, maxRow: 70000 }] }); if (/WHERE length\(toString/.test(q)) return J(400, { errorMessage: "unexpected '*' at line 1" }); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
          const rej = await sqlRun("SELECT i FROM base.blocks").catch((x) => x);
          ok(rej?.statusCode === 422 && rej?.queryBudgetSpent === true && !/unexpected '\*'/.test(rej.message) && sentR.filter((q) => !isHealth(q)).length === 3, `a 400 on the filtered run spends the budget: the uncharged 422 naming the budget, never surfaced as the buyer's SQL error (${rej instanceof Error ? rej.statusCode : rej.recovered}, ${sentR.filter((q) => !isHealth(q)).length} calls)`);
          // No row over the limit: the re-run path as before.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(200, { result: [{ n: 400, big: 0, maxRow: 30000 }] }); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
          const none = await sqlRun("SELECT i FROM base.blocks");
          ok(none.recovered === "result-size" && sentR.length === 3 && new RegExp(`LIMIT ${SQL_RECOVER_ROWS}$`).test(sentR[2]), `with no row over the limit the small re-run decides (${none.recovered}, ${sentR.length} calls)`);
          // The measure refused (a query at the depth limit, or any 4xx): the re-run path.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(400, { errorMessage: "SQL validation failed: subquery nesting too deep (max: 2)" }); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
          const refused = await sqlRun("SELECT i FROM base.blocks");
          ok(refused.recovered === "result-size" && sentR.length === 3, `a refused measure falls back to the small re-run (${sentR.length} calls)`);
          // A query already at the depth limit skips the measure (one more level would be refused).
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) throw new Error("the measure must not be sent for a deep query"); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
          const deepR = await sqlRun("SELECT a FROM (SELECT b FROM (SELECT c FROM base.blocks)) LIMIT 60000");
          ok(deepR.recovered === "result-size" && sentR.length === 2 && !sentR.some(isMeasure), `a query at the depth limit goes straight to the small re-run (${sentR.length} calls)`);
          // The filtered run itself failing (a total too large) spends the
          // budget: the uncharged 422 naming it, never a fourth query.
          sentR.length = 0;
          globalThis.fetch = async (url, init = {}) => { const q = JSON.parse(init.body || "{}").sql; sentR.push(q); if (sentR.length === 1) return J(500, {}); if (isMeasure(q)) return J(200, { result: [{ n: 9000, big: 3, maxRow: 70000 }] }); if (/WHERE length\(toString/.test(q)) return J(500, {}); return J(200, { result: Array.from({ length: SQL_RECOVER_ROWS }, (_, i) => ({ m: i, bals: "x".repeat(4000) })) }); };
          const both = await sqlRun("SELECT i FROM base.blocks").catch((x) => x);
          ok(both?.statusCode === 422 && both?.queryBudgetSpent === true && sentR.filter((q) => !isHealth(q)).length === 3, `a filtered run the service also refuses is the uncharged 422 naming the budget (${both?.statusCode}, ${sentR.filter((q) => !isHealth(q)).length} calls)`);
        }
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
      ok(cappedSql(`SELECT "union" AS u FROM (SELECT b FROM (SELECT c FROM t)) LIMIT 5000`).sql.endsWith(`LIMIT ${SQL_MAX_ROWS + 1}`) && cappedSql(deep.replace("SELECT a", "SELECT a, \`limit\`") + " LIMIT 5000").sql.endsWith(`LIMIT ${SQL_MAX_ROWS + 1}`), "a quoted identifier named union or limit is a column, not the clause");
      // The length cap: the query service takes 48 KB queries (measured), so
      // the cap is 60,000 characters, refused before any call, and the masks
      // that read a query stay linear at that size.
      {
        const { SQL_MAX_CHARS, sqlCode, hasOuterOrderBy, solanaRangeRefusal } = await import("../src/tools/cdp-kit.js");
        ok(SQL_MAX_CHARS === 60_000, "the SQL length cap is the measured one");
        ok(new RegExp(`max ${SQL_MAX_CHARS.toLocaleString("en-US")} chars`).test(tool("onchain-sql").discovery.inputSchema.properties.sql.description), "the tool description states the cap from the constant");
        const realFetchL = globalThis.fetch; let sentL = 0;
        globalThis.fetch = async () => { sentL++; return J(200, { result: [{ x: 1 }] }); };
        try {
          const longOk = "SELECT 1 AS x FROM base.blocks WHERE 1 = 1 " + "/* " + "p".repeat(SQL_MAX_CHARS - 60) + " */";
          const r = await sqlRun(longOk);
          ok(r.rowCount === 1 && sentL === 1 && longOk.length <= SQL_MAX_CHARS, `a query at the cap is sent (${longOk.length} chars)`);
          const over = await sqlRun(longOk + "x".repeat(SQL_MAX_CHARS - longOk.length + 1)).catch((x) => x);
          ok(over?.statusCode === 400 && /too long/.test(over.message) && /max 60,000/.test(over.message) && sentL === 1, `one past the cap is refused before any call (${over?.message?.slice(0, 60)})`);
        } finally { globalThis.fetch = realFetchL; }
        const hostile = ["'" + "\\'".repeat(SQL_MAX_CHARS / 2), "(".repeat(SQL_MAX_CHARS), "(SELECT ".repeat(Math.floor(SQL_MAX_CHARS / 8)), "limit ".repeat(SQL_MAX_CHARS / 6), "/**/".repeat(SQL_MAX_CHARS / 4),
          // An unterminated literal of escaped quotes ending in a lone backslash: the shape that was quadratic.
          "SELECT 1 FROM solana.instructions WHERE block_time >= \"" + "\\\"".repeat(SQL_MAX_CHARS / 2 - 40) + "\\", "'" + "\\'".repeat(SQL_MAX_CHARS / 2 - 1) + "\\", "`" + "\\`".repeat(SQL_MAX_CHARS / 2 - 1) + "\\"];
        const t0 = performance.now();
        for (const h of hostile) { sqlCode(h); subqueryDepth(h); cappedSql(h); hasOuterOrderBy(h); solanaRangeRefusal(h); }
        const took = performance.now() - t0;
        ok(took < 400, `the query readers stay linear on eight hostile queries at the cap (${took.toFixed(0)} ms)`);
      }
      ok(cappedSql(deep + " LIMIT" + " ".repeat(60) + "5000").sql === deep + " LIMIT" + " ".repeat(60) + String(SQL_MAX_ROWS + 1) && cappedSql(deep + " LIMIT\n\n  5000").sql === deep + ` LIMIT\n\n  ${SQL_MAX_ROWS + 1}`, "a count far from its LIMIT (spaces, lines) is still the outer LIMIT");
      const expr = cappedSql(deep + " LIMIT (5000)");
      ok(expr.capped === false && expr.sql === deep + " LIMIT (5000)" && cappedSql(deep + " LIMIT 1e3").capped === false, "an outer LIMIT whose count is an expression is left as written, never doubled");
      ok(cappedSql(deep + " ORDER BY a OFFSET 5").capped === false && cappedSql(deep + " ORDER BY a OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY").capped === false && cappedSql(deep + " LIMIT 5 OFFSET 5").sql.endsWith("LIMIT 5 OFFSET 5"), "an outer OFFSET or FETCH with no LIMIT before it is left as written; with a LIMIT it is capped as usual");
      ok(cappedSql(deep + " ORDER BY a OFFSET" + " ".repeat(30) + "5").capped === false && cappedSql(deep + " ORDER BY a OFFSET (5)").capped === false && cappedSql(deep + " ORDER BY a\nOFFSET\n5").capped === false, "an outer OFFSET far from its count, or with an expression, is still the clause");
      ok(["SELECT a AS offset FROM (SELECT b FROM (SELECT c FROM t))", "SELECT t.fetch, t.offset FROM (SELECT b FROM (SELECT c FROM t)) WHERE t.offset = 5", "SELECT a FROM (SELECT b FROM (SELECT c FROM t)) WHERE t.limit = 5", "SELECT a FROM (SELECT b FROM (SELECT c FROM t)) WHERE t.union = 1"].every((q) => cappedSql(q).capped === true && cappedSql(q).sql.endsWith(`LIMIT ${SQL_MAX_ROWS + 1}`)), "a column named offset, fetch, limit or union (bare or dotted) is not the clause: the cap is appended");
      const named = cappedSql(`SELECT 1 AS "a limit 5000", "x union y" FROM (SELECT b FROM (SELECT c FROM t)) LIMIT 9000`);
      ok(named.sql === `SELECT 1 AS "a limit 5000", "x union y" FROM (SELECT b FROM (SELECT c FROM t)) LIMIT ${SQL_MAX_ROWS + 1}` && subqueryDepth(`SELECT "(select" FROM t`) === 0, "the inside of a quoted identifier is neither a LIMIT, a UNION nor a subquery");
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
        const { _resetCdpLogThrottleForTest } = await import("../src/tools/cdp-kit.js");
        _resetCdpLogThrottleForTest();
        const warnedN = []; const realWarnN = console.warn; console.warn = (m) => warnedN.push(String(m));
        const f = await sqlRun("SELECT a FROM (SELECT b FROM t) LIMIT 50").catch((x) => x);
        console.warn = realWarnN;
        ok(!(f instanceof Error) && sent.length === 2 && /^SELECT \* FROM \(/.test(sent[0]) && sent[1] === "SELECT a FROM (SELECT b FROM t) LIMIT 50" && f.rowCount === 3 && f.complete === true, `a nesting refusal of the wrapper is answered by the query under its own LIMIT (${sent.length} calls${f instanceof Error ? `, ${f.statusCode}` : ""})`);
        ok(!warnedN.some((w) => w.startsWith("[cdp] failed buyer query")), `the wrapper's own refusal is not logged as a failed buyer query (${warnedN.length} warnings)`);
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
        globalThis.fetch = async () => J(400, { errorMessage: "invalid syntax at line 3, column 0 (position start: 20, position end: 164)" });
        const w = await sqlRun("SELECT a FROM t\nWHERE").catch((x) => x);
        const n = await sqlRun(deep + "\nWHERE").catch((x) => x);
        ok(w?.statusCode === 422 && /at line 2, column 0 \(position start: 4, position end: 148\)/.test(w.message) && n?.statusCode === 422 && /at line 3, column 0 \(position start: 20, position end: 164\)/.test(n.message), `a line and a position in the service's refusal are the buyer's (wrapped: "${w?.message?.slice(-60)}", unwrapped: "${n?.message?.slice(-60)}")`);
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
      {
        const { QUERY_HEALTH_SQL: H } = await import("../src/tools/cdp-kit.js");
        ok(solanaRangeRefusal(H.solana) === null && /\bWHERE block_time > now\(\) - INTERVAL 1 DAY LIMIT 1$/.test(H.solana), `the Solana health query is bounded by block_time, the table's pruning key (${H.solana})`);
      }
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
      // Synchronous scans, read as the time the thread had a core, least of three (scripts/lib/ours-clock.js).
      { const { ms } = leastOurs(() => { for (let i = 0; i < 10; i++) blockTimeRangeDays("SELECT 1 WHERE block_time >= now ( ) - interval 1 " + "a".repeat(9_900), at); }); ok(ms < 200, `the range reader stays fast on a 10 KB adversarial query (${ms.toFixed(1)} ms for 10 reads)`); }
      { const { cappedSql: capQ } = await import("../src/tools/cdp-kit.js"); const bad10k = "SELECT '" + "\\'".repeat(4_995); const { ms } = leastOurs(() => { for (let i = 0; i < 10; i++) { capQ(bad10k); solanaRangeRefusal(bad10k); sqlNorm(bad10k); } }); ok(ms < 100, `an unclosed string of escaped quotes stays linear through every mask (${ms.toFixed(1)} ms for 30 passes)`); }
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

// --- onchain-sql answers: the bytes read, a fast 502, the 408, the 422's
// machine fields, and a Solana-paid call's budget (stubbed fetch) -----------
{
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
  process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "pkcs8", format: "pem" });
  const m = await import("../src/tools/cdp-kit.js");
  const { currentBudget } = await import("../src/upstream-deadline.js");
  m._resetSqlPacerForTest(0);
  m._setQueryHealthForTest(true);
  m._setSlowQueryGatewayMsForTest(40);
  const realFetch = globalThis.fetch;
  let calls = 0, reply = null, budgets = [];
  globalThis.fetch = async (url, init = {}) => { calls++; const b = currentBudget(); budgets.push(b ? { total: b.totalMs, left: b.remaining() } : null); return reply(calls, String(url), init); };
  const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const run = (sql = "SELECT block_number FROM base.blocks", req) => tool("onchain-sql").handler({ sql }, req);
  try {
    // d-17: the bytes read from the query service are bounded. A body past
    // the bound is not read to its end: the read stops there and the call
    // ends 502, uncharged (a valid answer that large would otherwise be read
    // whole, parsed and served).
    {
      const MB = 1 << 20;
      ok(m.SQL_READ_MAX_BYTES === 16 * MB, `the query service's answer is read up to 16 MB (${m.SQL_READ_MAX_BYTES})`);
      let pulled = 0, cancelled = false;
      const head = new TextEncoder().encode('{"result":[');
      reply = () => { pulled = 0; cancelled = false; return new Response(new ReadableStream({
        pull(c) { if (pulled >= 40 * MB) { c.close(); return; } const chunk = pulled === 0 ? head : new Uint8Array(MB).fill(32); pulled += chunk.length; c.enqueue(chunk); },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } }); };
      calls = 0;
      let e = await run().catch((x) => x);
      ok(e?.statusCode === 502 && /larger than this server reads/.test(e?.message) && /Nothing was charged\.$/.test(e?.message) && pulled < 20 * MB && cancelled && calls === 1 && m._buyerQueriesInflightForTest() === 0,
        `a 40 MB answer is read to the 16 MB bound only, cancelled, and answered 502 uncharged, not resent (${e?.statusCode ?? 200}, read ${Math.round(pulled / MB)} MB, cancelled ${cancelled}, sends ${calls})`);
      // A complete, valid answer past the bound: on the old read it was parsed and served.
      const row = JSON.stringify({ x: "y".repeat(17_000) });
      const big = `{"result":[${Array.from({ length: 1_001 }, () => row).join(",")}]}`;
      reply = () => new Response(big, { status: 200, headers: { "content-type": "application/json" } });
      calls = 0;
      e = await run().catch((x) => x);
      ok(e?.statusCode === 502 && /larger than this server reads/.test(e?.message) && calls === 1, `a valid ${Math.round(big.length / MB)} MB answer is not served whole: 502, uncharged (${e?.statusCode ?? `200 with ${e?.rowCount} rows`})`);
      // Control: an answer under the bound is served.
      reply = () => new Response(`{"result":[${Array.from({ length: 50 }, () => row).join(",")}]}`, { status: 200, headers: { "content-type": "application/json" } });
      const r = await run().catch((x) => x);
      ok(r?.rowCount === 50, `control: an answer under the bound (about 0.8 MB) is served (${r?.rowCount ?? r?.statusCode})`);
    }
    // d-15 (U3): a 502 or 504 that comes back fast did not run into the
    // service's time window: it is an upstream error to retry, never the
    // "narrow it, resending fails the same way" answer.
    {
      reply = () => J(502, { errorMessage: "Bad Gateway" });
      calls = 0;
      const e = await run().catch((x) => x);
      ok(e?.statusCode === 502 && e?.hint !== "narrow-query" && /retry shortly/.test(e?.message) && !/answer window|Narrow it|fails the same way/.test(e?.message) && /Nothing was charged\.$/.test(e?.message) && calls === 2,
        `a fast 502 twice is a 502 to retry, without the slow-query advice (${e?.statusCode}, hint ${e?.hint}, sends ${calls}: "${String(e?.message).slice(0, 90)}")`);
      reply = () => J(504, {});
      calls = 0;
      const e4 = await run().catch((x) => x);
      ok(e4?.statusCode === 502 && e4?.hint !== "narrow-query" && /HTTP 504/.test(e4?.message) && /retry shortly/.test(e4?.message), `the same for a fast 504 (${e4?.statusCode}, "${String(e4?.message).slice(0, 60)}")`);
      // Control: a fast 502 then an answer is served.
      reply = (n) => (n === 1 ? J(502, {}) : J(200, { result: [{ x: 1 }] }));
      calls = 0;
      ok((await run()).rowCount === 1 && calls === 2, "control: a fast 502 then an answer is served");
    }
    // d-15 (U4): the service's documented time-limit answer, 408 timed_out,
    // is the caller's query to narrow: 422, a machine hint, not resent.
    {
      reply = () => new Promise((r) => setTimeout(() => r(J(408, { errorType: "timed_out", errorMessage: "Query execution was cut off by the server. Please try again with a more efficient query." })), 30));
      calls = 0;
      const e = await run().catch((x) => x);
      ok(e?.statusCode === 422 && e?.hint === "timed-out" && /cut this query off/.test(e?.message) && /select fewer columns/.test(e?.message) && /Nothing was charged\.$/.test(e?.message) && calls === 1,
        `a 408 timed_out is one 422 with hint timed-out and how to narrow it (${e?.statusCode}, hint ${e?.hint}, sends ${calls})`);
      ok(e?.charged === false && Number.isInteger(e?.upstreamMs) && e.upstreamMs >= 25, `the 408's 422 carries charged false and the time the query service took (${e?.charged}, ${e?.upstreamMs} ms)`);
    }
    // d-15 (U7): every uncharged narrow-query 422 carries the numbers, not
    // only the sentence: charged false and the ms the call's queries spent.
    {
      reply = () => new Promise((r) => setTimeout(() => r(J(502, { errorMessage: "Bad Gateway" })), 60));
      calls = 0;
      const slow = await run().catch((x) => x);
      ok(slow?.statusCode === 422 && slow?.hint === "narrow-query" && slow?.charged === false && Number.isInteger(slow?.upstreamMs) && slow.upstreamMs >= 50,
        `the slow-cutoff 422 carries charged false and upstreamMs (${slow?.statusCode}, ${slow?.charged}, ${slow?.upstreamMs})`);
      // Every send an instant 500 (the result too large): the budget of
      // queries ends in the 422.
      reply = () => J(500, { errorMessage: "internal" });
      calls = 0;
      const spent = await run().catch((x) => x);
      ok(spent?.statusCode === 422 && spent?.hint === "narrow-query" && spent?.charged === false && Number.isInteger(spent?.upstreamMs) && spent.upstreamMs >= 0 && calls === m.SQL_QUERY_BUDGET,
        `the query-budget 422 carries charged false and upstreamMs (${spent?.statusCode}, ${spent?.charged}, ${spent?.upstreamMs}, sends ${calls})`);
      // Control: a served answer carries neither.
      reply = () => J(200, { result: [{ x: 1 }] });
      const r = await run();
      ok(r.rowCount === 1 && !("charged" in r) && !("upstreamMs" in r), "control: a served answer's shape is unchanged");
    }
    // d-16 (U5): a call paid on Solana runs under a budget its payment can
    // outlast (the signed transaction lands only while its recent blockhash
    // is valid), not the EVM payment window the route is wrapped with; a
    // call paid on an EVM network keeps that window.
    {
      const header = (network) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network }, payload: { transaction: "AQ==" } })).toString("base64");
      const reqOf = (network) => { const h = header(network); return { headers: { "payment-signature": h }, header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) }; };
      const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
      ok(m.SVM_SQL_BUDGET_MS === 40_000, `a Solana-paid SQL call's budget is 40 s (${m.SVM_SQL_BUDGET_MS})`);
      reply = (n, url) => (/\/schema$/.test(url) ? J(200, { "base.blocks": [] }) : J(200, { result: [{ x: 1 }] }));
      budgets = [];
      await run(undefined, reqOf(SOL));
      await tool("onchain-sql-schema").handler({}, reqOf(SOL));
      const [solSql, solSchema] = budgets;
      ok(solSql?.left <= 40_000 && solSql?.left > 39_000 && solSchema?.left <= 40_000 && solSchema?.left > 39_000,
        `on Solana both SQL routes run under 40 s (query ${solSql?.left} ms left, schema ${solSchema?.left} ms left)`);
      budgets = [];
      await run(undefined, reqOf("eip155:8453"));
      await tool("onchain-sql-schema").handler({}, reqOf("eip155:8453"));
      await run(undefined, {});
      ok(budgets.every((b) => b?.left > 200_000), `control: paid on Base, or with no payment header, the route's own window holds (${budgets.map((b) => b?.left).join(", ")} ms left)`);
      // A stalled query on Solana ends inside the 40 s, as the uncharged deadline answer.
      m._setCdpReadMsForTest(60_000);
      const realTimeout = AbortSignal.timeout;
      let capSeen = null;
      AbortSignal.timeout = (ms) => { capSeen = ms; return realTimeout.call(AbortSignal, 30); };
      reply = (n, url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true }));
      calls = 0;
      const keep = setInterval(() => {}, 1000); // the abort timer alone does not hold the process open
      const e = await run(undefined, reqOf(SOL)).catch((x) => x);
      clearInterval(keep);
      AbortSignal.timeout = realTimeout;
      m._setCdpReadMsForTest(null);
      ok(e?.statusCode === 503 && capSeen <= 40_000 && capSeen > 39_000, `a stalled Solana-paid query's read is capped by the 40 s budget, not the 60 s read limit (${e?.statusCode}, cap ${capSeen} ms)`);
    }
  } finally {
    globalThis.fetch = realFetch;
    m._setSlowQueryGatewayMsForTest(8_000);
    delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET;
  }
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
