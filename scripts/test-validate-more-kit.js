// id-validate, build-log-triage, json-repair (src/tools/validate-more-kit.js)
// and solana-rpc (src/tools/solana-rpc-kit.js). Offline: the RPC tool reads a
// stubbed fetch, installed under the egress meter so the provider's daily
// ceiling is exercised the way production meets it.
//
//   node scripts/test-validate-more-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

// The meter wraps whatever globalThis.fetch is when it installs; later blocks swap `inner`.
let inner = async () => new Response("{}");
globalThis.fetch = (...a) => inner(...a);
const { installEgressMeter } = await import("../src/egress-meter.js");
installEgressMeter();

const { VALIDATE_MORE_TOOLS, _test } = await import("../src/tools/validate-more-kit.js");
const { SOLANA_RPC_TOOLS, SOLANA_RPC_METHODS, checkSolanaRpcRequest } = await import("../src/tools/solana-rpc-kit.js");
const { _resetHardCaps } = await import("../src/upstream-hard-caps.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => [...VALIDATE_MORE_TOOLS, ...SOLANA_RPC_TOOLS].find((t) => t.slug === slug);
const run = (slug, input) => tool(slug).handler(input);
const status = async (fn) => { try { await fn(); return 200; } catch (e) { return e.statusCode ?? "throw:" + e.message; } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- free tier and wallet-only placement -----------------------------------
for (const s of ["id-validate", "build-log-triage", "json-repair"]) ok(FREE_TIER_SLUGS.has(s) && !WALLET_ONLY_SLUGS.has(s), `${s} is on the free tier`);
ok(!FREE_TIER_SLUGS.has("solana-rpc") && WALLET_ONLY_SLUGS.has("solana-rpc"), "solana-rpc is wallet-only");

// --- every published example answers with data ------------------------------
for (const t of VALIDATE_MORE_TOOLS) {
  const r = await t.handler(t.discovery.input);
  const ex = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(ex), `${t.slug}: the published example is the handler's own answer`);
}

// --- id-validate -------------------------------------------------------------
// Synthetic vectors: a counting-pattern body whose check characters were
// computed from the published rule, never a person's or company's number. The
// alphanumeric CNPJ is the issuing authority's own documentation example; the
// ISIN is the standard's worked example. The invalid twin changes one check character.
const ID_VECTORS = [
  ["bic", "ABCDGB2L", "ABCDQQ2L"],
  ["bic", "ABCDGB2LXXX", "ABCD1B2LXXX"],
  ["uk-nino", "AB123456C", "AB123456E"],
  ["uk-nino", "AB123456C", "BG123456C"],
  ["uk-nino", "AB123456C", "DA123456C"],
  ["br-cpf", "123.456.789-09", "123.456.789-08"],
  ["br-cpf", "987.654.321-00", "111.111.111-11"],
  ["br-cnpj", "12.345.678/0001-95", "12.345.678/0001-96"],
  ["br-cnpj", "12.ABC.345/01DE-35", "12.ABC.345/01DE-36"],
  ["au-abn", "18 123 456 789", "19 123 456 789"],
  ["sedol", "B123456", "B123457"],
  ["sedol", "1234563", "1234564"],
  ["isin", "US0378331005", "US0378331006"],
  ["isin", "XS0000000017", "XS0000000018"],
  ["lei", "5299000000TEST000158", "5299000000TEST000159"],
  ["lei", "9845000000ABCDEF1290", "9845000000ABCDEF1291"],
  ["no-orgnr", "812 345 672", "812 345 673"],
  ["no-orgnr", "998877660", "998877661"],
];
for (const [type, good, badv] of ID_VECTORS) {
  const g = _test.idValidate({ type, value: good });
  const b = _test.idValidate({ type, value: badv });
  ok(g.valid === true && g.type === type && g.registryChecked === false, `id-validate ${type} ${good} is valid (${g.reason})`);
  ok(b.valid === false && typeof b.reason === "string" && b.reason.length > 0, `id-validate ${type} ${badv} is invalid (${b.reason})`);
}
{
  // No check digit exists when the MOD 11 remainder gives 10.
  const r = _test.idValidate({ type: "no-orgnr", value: "912345670" });
  ok(r.valid === false && /No check digit/.test(r.reason), "id-validate no-orgnr: a body whose check would be 10 is never valid");
  const a = _test.idValidate({ type: "swift", value: "abcd gb 2l" });
  ok(a.type === "bic" && a.valid && a.normalized === "ABCDGB2L", "id-validate: aliases and normalization (case, spaces)");
  const d = _test.idValidate({ value: "12345678909" });
  ok(d.detected && d.type === "br-cpf" && d.valid && d.candidates.some((c) => c.type === "au-abn"), "id-validate detect: an 11-digit value lists CPF and ABN as candidates and picks the valid one");
  const amb = _test.idValidate({ value: "123456789" });
  ok(amb.detected && amb.candidates.length >= 1 && amb.candidates[0].type === "no-orgnr", "id-validate detect: a 9-digit value is a Norwegian organization number candidate");
  const none = _test.idValidate({ value: "hello world!" });
  ok(none.type === null && none.valid === false && none.candidates.length === 0, "id-validate detect: an unrecognized shape names no type");
  ok(await status(() => run("id-validate", { value: "x".repeat(65) })) === 400, "id-validate: a value over 64 characters is 400");
  ok(await status(() => run("id-validate", { value: "AB123456C", type: "ssn" })) === 400, "id-validate: an unknown type is 400 naming the list");
  ok(await status(() => run("id-validate", { value: { toString: 1 } })) === 400, "id-validate: a non-string value is 400");
  ok(await status(() => run("id-validate", {})) === 400, "id-validate: a missing value is 400");
}

// --- build-log-triage ----------------------------------------------------------
const LOGS = {
  "dependency-resolution": "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error Found: react@18.3.1",
  "compile-error": "> tsc -p .\nsrc/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.",
  "test-failure": "PASS src/a.test.js\nFAIL src/b.test.js\n  ● sum adds\n    expect(received).toBe(expected)\nTests:       1 failed, 3 passed, 4 total",
  timeout: "Running tests\n##[error]The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 360 minutes.",
  "out-of-memory": "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nAborted (core dumped)",
  network: "Collecting requests\n  WARNING: Retrying after connection broken by 'NewConnectionError: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution'",
  permission: "remote: Permission to octo/repo.git denied to github-actions[bot].\nfatal: unable to access 'https://example.com/octo/repo.git/': The requested URL returned error: 403",
  "lockfile-mismatch": " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json",
};
for (const [cls, log] of Object.entries(LOGS)) {
  const r = await run("build-log-triage", { log });
  ok(r.errorClass === cls, `build-log-triage classifies ${cls} (got ${r.errorClass})`);
  ok(r.firstError && r.firstError.line >= 1 && r.lines.some((l) => l.line === r.firstError.line), `build-log-triage ${cls}: the first error's line is among the lines shown`);
  ok(typeof r.nextStep === "string" && r.nextStep.length > 20, `build-log-triage ${cls}: a fixed next step`);
}
{
  const cargo = "   Compiling app v0.1.0 (/w/app)\nerror[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:13\nerror: could not compile `app` (bin \"app\") due to 1 previous error";
  const r = await run("build-log-triage", { log: cargo });
  ok(r.errorClass === "compile-error" && r.firstError.line === 2 && r.ecosystems.includes("cargo"), "build-log-triage: cargo compile error, line 2, cargo ecosystem");
  const go = "--- FAIL: TestSum (0.00s)\n    sum_test.go:9: got 3 want 4\nFAIL\nFAIL\texample.com/m\t0.002s";
  const g = await run("build-log-triage", { log: go });
  ok(g.errorClass === "test-failure" && g.firstError.line === 1 && g.ecosystems.includes("go"), "build-log-triage: go test failure");
  const gh = "2026-11-01T10:00:00.0000000Z ##[group]Run npm test\n2026-11-01T10:00:00.1000000Z npm test\n2026-11-01T10:00:00.2000000Z ##[endgroup]\n2026-11-01T10:00:05.0000000Z \u001b[31mnot ok 1 - adds\u001b[0m\n2026-11-01T10:00:06.0000000Z ##[error]Process completed with exit code 1.";
  const h = await run("build-log-triage", { log: gh });
  ok(h.errorClass === "test-failure" && h.failingStep?.text === "Run npm test" && h.exitCode === 1 && h.firstError.text === "not ok 1 - adds", "build-log-triage: GitHub Actions timestamps and color codes are cut; step and exit code read");
  const mvn = "[INFO] BUILD FAILURE\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project app: There are test failures.";
  const m = await run("build-log-triage", { log: mvn });
  ok(m.errorClass === "test-failure" && m.failingCommand?.text.startsWith("mvn org.apache.maven.plugins:maven-surefire-plugin"), "build-log-triage: Maven goal is the failing command");
  const u = await run("build-log-triage", { log: "step one\nError: something odd happened\nstep two" });
  ok(u.errorClass === "unknown" && u.firstError?.line === 2 && u.nextStep.includes("no known failure pattern"), "build-log-triage: an unclassified error line stands in as the first error");
  const clean = await run("build-log-triage", { log: "all good\ndone" });
  ok(clean.firstError === null && clean.errorClass === "unknown" && clean.complete === true, "build-log-triage: a clean log names no error");
  const many = Array.from({ length: 500 }, (_, k) => `FAIL src/t${k}.test.js`).join("\n");
  const mr = await run("build-log-triage", { log: many });
  ok(mr.lines.length <= 30 && mr.matched === 500 && mr.truncated === true && mr.signals["test-failure"] === 500, "build-log-triage: a long run of errors is capped and says so in fields");
  // Linear on its bound: long lines and many short lines of each matcher's near-miss shape.
  for (const [label, text] of [
    ["one long line", ".go:1".repeat(20_000)],
    ["equals signs", ("=".repeat(999) + "\n").repeat(100)],
    ["near-miss lines", ("Tests run: 1, Failures: 0, Errors: 0 error TS memory allocation of 1 bytes\n").repeat(1_300)],
    ["empty lines", "\n".repeat(100_000)],
    ["digits", ("1".repeat(990) + ".java:" + "\n").repeat(99)],
  ]) {
    const t0 = performance.now();
    const r = await errOf(() => run("build-log-triage", { log: text.slice(0, 100_000) }));
    const ms = performance.now() - t0;
    ok(ms < 1_500, `build-log-triage: ${label} at the size bound runs in ${Math.round(ms)} ms (${r ? r.statusCode : "answered"})`);
  }
  ok(await status(() => run("build-log-triage", { log: "x".repeat(100_001) })) === 400, "build-log-triage: a log over 100,000 bytes is 400");
  ok(await status(() => run("build-log-triage", { log: "é".repeat(60_000) })) === 400, "build-log-triage: the bound is in bytes, not characters");
}

// --- json-repair ---------------------------------------------------------------
const REPAIRS = [
  ["{\"a\": 1,}", { a: 1 }, ["trailing-comma"]],
  ["[1, 2, 3,]", [1, 2, 3], ["trailing-comma"]],
  ["{'a': 'it\\'s'}", { a: "it's" }, ["single-quotes"]],
  ["{a: 1, b_2: true}", { a: 1, b_2: true }, ["unquoted-key"]],
  ["{\"a\": 1 /* why */, // note\n\"b\": 2}", { a: 1, b: 2 }, ["comment"]],
  ["{\"a\": [1, 2, {\"b\": 3", { a: [1, 2, { b: 3 }] }, ["missing-bracket"]],
  ["{“a”: “b”}", { a: "b" }, ["smart-quotes"]],
  ["[NaN, undefined, Infinity, -Infinity]", [null, null, null, null], ["non-json-literal"]],
  ["{\"ok\": True, \"no\": False, \"x\": None}", { ok: true, no: false, x: null }, ["literal-case", "non-json-literal"]],
  ["```json\n{\"a\": 1}\n```", { a: 1 }, ["code-fence"]],
  ["{\"a\": \"line\nbreak\"}", { a: "line\nbreak" }, ["control-character"]],
  ["{\"a\": \"open", { a: "open" }, ["unterminated-string"]],
  ["[1,,2]", [1, 2], ["extra-comma"]],
  ["{\"a\": 'say \"hi\"'}", { a: "say \"hi\"" }, ["single-quotes"]],
  ["{\"a\": +1}", { a: 1 }, ["number"]],
];
for (const [text, want, kinds] of REPAIRS) {
  const r = await run("json-repair", { json: text });
  ok(JSON.stringify(JSON.parse(r.repaired)) === JSON.stringify(want), `json-repair ${JSON.stringify(text).slice(0, 50)} -> ${r.repaired.slice(0, 50)}`);
  ok(kinds.every((k) => r.fixKinds[k] > 0) && r.changed, `json-repair ${JSON.stringify(text).slice(0, 40)} lists ${kinds.join(", ")}`);
}
{
  const valid = "{\"a\": [1, 2], \"b\": {\"c\": null}}";
  const r = await run("json-repair", { json: valid });
  ok(r.changed === false && r.fixCount === 0 && JSON.stringify(JSON.parse(r.repaired)) === JSON.stringify(JSON.parse(valid)), "json-repair: valid JSON comes back unchanged with no fixes");
  const t = await run("json-repair", { json: "{\n  \"a\": 1,\n  \"b\": [true,],\n}" });
  const tc = t.fixes.filter((f) => f.kind === "trailing-comma");
  ok(tc.length === 2 && tc[0].line === 3 && tc[0].column === 13 && tc[1].line === 3 && tc[1].column === 15, "json-repair: each fix names the line and column of the character it changed");
  for (const [text, why] of [
    ["{\"a\": hello}", /Unquoted word "hello"/],
    ["[1, 2}", /does not match/],
    ["{\"a\" 1}", /Expected ":"/],
    ["[1 2]", /Expected "," or "\]"/],
    ["", /required/],
    ["{\"a\": 01}", /not a JSON number/],
    ["/* never closed", /never closed/],
    ["[1] [2]", /More than one JSON value/],
  ]) {
    const e = await errOf(() => run("json-repair", { json: text }));
    ok(e?.statusCode === 400 && why.test(e.message), `json-repair refuses ${JSON.stringify(text)} with a reason (${e?.message})`);
  }
  const deep = "[".repeat(600);
  ok((await errOf(() => run("json-repair", { json: deep })))?.statusCode === 400, "json-repair: nesting past 512 levels is 400");
  ok(await status(() => run("json-repair", { json: "x".repeat(100_001) })) === 400, "json-repair: input over 100,000 characters is 400");
  // Linear on its bound: 30,000 trailing commas, 25,000 comments, 50,000 open brackets.
  for (const [label, text] of [
    ["trailing commas", "[" + "[1,],".repeat(19_999) + "[1,]]"],
    ["comments", "[" + "1/**/,".repeat(16_000) + "1]"],
    ["open brackets", "[".repeat(511) + "1,".repeat(40_000)],
    ["keys", "{" + "a:1,".repeat(24_000) + "}"],
  ]) {
    const t0 = performance.now();
    const r = await errOf(() => run("json-repair", { json: text.slice(0, 100_000) }));
    const ms = performance.now() - t0;
    ok(ms < 1_500, `json-repair: ${label} at the size bound runs in ${Math.round(ms)} ms (${r ? r.statusCode : "repaired"})`);
  }
  const many = await run("json-repair", { json: "[" + "1,".repeat(300) + "]" + "" });
  ok(many.fixCount === 1, "json-repair: one trailing comma in a long list is one fix");
  const capped = await run("json-repair", { json: "[" + "'a',".repeat(300) + "'b']" });
  ok(capped.fixes.length === 200 && capped.fixCount === 301 && capped.truncated === true && capped.matched === 301, "json-repair: the fix list is capped at 200 and says so in fields");
}

// --- solana-rpc ----------------------------------------------------------------
const rpcOk = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
const rpcErr = (code, message, statusCode = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: statusCode, headers: { "content-type": "application/json" } });
const ADDR = "11111111111111111111111111111111";
const SIG = "5".repeat(87);
{
  ok(!SOLANA_RPC_METHODS.includes("getProgramAccounts") && SOLANA_RPC_METHODS.every((m) => /^(get|is)[A-Z]/.test(m)), "solana-rpc: the allowlist holds reads only and no getProgramAccounts");
  for (const m of ["getProgramAccounts", "sendTransaction", "simulateTransaction", "requestAirdrop", "accountSubscribe", "getLargestAccounts"]) {
    ok(await status(() => run("solana-rpc", { method: m, params: [] })) === 400, `solana-rpc refuses ${m} before any egress`);
  }
  ok(checkSolanaRpcRequest({ method: "GETSLOT" }).method === "getSlot", "solana-rpc: methods match case-insensitively and go upstream in canonical casing");
  const blk = checkSolanaRpcRequest({ method: "getBlock", params: [250000000] });
  ok(blk.params[1].transactionDetails === "none" && blk.params[1].rewards === false && blk.params[1].maxSupportedTransactionVersion === 0, "solana-rpc: getBlock defaults to no transaction list and no rewards");
  ok(await status(() => checkSolanaRpcRequest({ method: "getBlock", params: [1, { transactionDetails: "full" }] })) === 400, "solana-rpc: getBlock with full transactions is refused");
  const sigs = checkSolanaRpcRequest({ method: "getSignaturesForAddress", params: [ADDR] });
  ok(sigs.params[1].limit === 20, "solana-rpc: getSignaturesForAddress defaults to 20 rows");
  ok(await status(() => checkSolanaRpcRequest({ method: "getSignaturesForAddress", params: [ADDR, { limit: 1000 }] })) === 400, "solana-rpc: a limit over 100 is refused");
  ok(checkSolanaRpcRequest({ method: "getTransaction", params: [SIG] }).params[1].maxSupportedTransactionVersion === 0, "solana-rpc: getTransaction reads versioned transactions by default");
  ok(await status(() => checkSolanaRpcRequest({ method: "getBalance", params: ["0xabc"] })) === 400, "solana-rpc: a non-base58 address is refused");
  ok(await status(() => checkSolanaRpcRequest({ method: "getAccountInfo", params: [ADDR, { filters: [] }] })) === 400, "solana-rpc: an unknown config field is refused");
  ok(await status(() => checkSolanaRpcRequest({ method: "getSignatureStatuses", params: [Array(21).fill(SIG)] })) === 400, "solana-rpc: more than 20 signatures is refused");
  ok(await status(() => checkSolanaRpcRequest({ method: "getSlot", params: [1, 2, 3, 4, 5] })) === 400, "solana-rpc: more than 4 params is refused");
  ok(await status(() => checkSolanaRpcRequest({ method: "getTokenAccountsByOwner", params: [ADDR, { mint: ADDR, programId: ADDR }] })) === 400, "solana-rpc: a token filter must be exactly one of mint or programId");
  ok(await status(() => checkSolanaRpcRequest({ method: "getSlot", network: "devnet" })) === 400, "solana-rpc: only mainnet is served");
  // Heavy reads are refused or bounded before any egress.
  ok(await status(() => checkSolanaRpcRequest({ method: "getSlot", network: { toString: 1 } })) === 400 && await status(() => checkSolanaRpcRequest({ method: "getSlot", network: 1 })) === 400, "solana-rpc: a network that is not text is a 400");
  ok(await status(() => checkSolanaRpcRequest({ method: "getTokenAccountsByOwner", params: [ADDR, { programId: ADDR }] })) === 400, "solana-rpc: an owner-wide programId scan is refused (name the mint)");
  ok(checkSolanaRpcRequest({ method: "getTokenAccountsByOwner", params: [ADDR, { mint: ADDR }] }).params[1].mint === ADDR, "solana-rpc: a mint filter is read");
  for (const enc of [undefined, "base64", "base58", "base64+zstd"]) {
    const cfg = enc ? { encoding: enc } : undefined;
    ok(await status(() => checkSolanaRpcRequest({ method: "getAccountInfo", params: cfg ? [ADDR, cfg] : [ADDR] })) === 400, `solana-rpc: getAccountInfo in ${enc || "the default base64"} without a dataSlice is refused`);
    ok(await status(() => checkSolanaRpcRequest({ method: "getAccountInfo", params: [ADDR, { ...(cfg || {}), dataSlice: { offset: 0, length: 70_000 } }] })) === 400, `solana-rpc: a dataSlice over 64 KB in ${enc || "base64"} is refused`);
    ok(checkSolanaRpcRequest({ method: "getAccountInfo", params: [ADDR, { ...(cfg || {}), dataSlice: { offset: 0, length: 1024 } }] }).params[1].dataSlice.length === 1024, `solana-rpc: getAccountInfo in ${enc || "base64"} with a dataSlice is read`);
  }
  ok(checkSolanaRpcRequest({ method: "getAccountInfo", params: [ADDR, { encoding: "jsonParsed" }] }).params[1].encoding === "jsonParsed", "solana-rpc: getAccountInfo in jsonParsed is read without a slice");

  process.env.SOLANA_RPCS = "https://rpc-a.example.com,https://rpc-b.example.com";
  _resetHardCaps();
  const seen = [];
  inner = async (url, init) => { seen.push([new URL(String(url)).host, JSON.parse(init.body)]); return seen.length === 1 ? rpcErr(-32429, "rate limit", 429) : rpcOk(380000000); };
  const r = await run("solana-rpc", { method: "getSlot", params: [] });
  ok(r.result === 380000000 && r.method === "getSlot" && r.network === "mainnet", "solana-rpc: answers the node's result");
  ok(seen.length === 2 && seen[0][0] === "rpc-a.example.com" && seen[1][0] === "rpc-b.example.com", "solana-rpc: a provider rate limit walks to the next endpoint");
  ok(seen[1][1].method === "getSlot" && Array.isArray(seen[1][1].params), "solana-rpc: the upstream body is a JSON-RPC request");

  seen.length = 0;
  inner = async (url, init) => { seen.push(String(url)); return rpcErr(-32009, "Slot 1 was skipped, or missing in long-term storage"); };
  const e = await errOf(() => run("solana-rpc", { method: "getBlock", params: [1] }));
  ok(e?.statusCode === 502 && /Node error: Slot 1 was skipped/.test(e.message) && seen.length === 1, "solana-rpc: a node's own error is a 502 answer, not a walk");

  inner = async () => rpcOk({ value: "x".repeat(210_000) });
  ok((await errOf(() => run("solana-rpc", { method: "getAccountInfo", params: [ADDR, { encoding: "jsonParsed" }] })))?.statusCode === 413, "solana-rpc: a result over 200KB is 413");
  inner = async () => new Response("{\"result\":\"" + "y".repeat(2_100_000) + "\"}", { status: 200 });
  ok((await errOf(() => run("solana-rpc", { method: "getAccountInfo", params: [ADDR, { encoding: "jsonParsed" }] })))?.statusCode === 413, "solana-rpc: a node body over the read cap is cut off and answers 413");

  // A block's signature list is served cut and marked, never a 413.
  inner = async () => rpcOk({ blockHeight: 1, blockhash: ADDR, signatures: Array.from({ length: 3000 }, () => SIG) });
  const big = await run("solana-rpc", { method: "getBlock", params: [250000000, { transactionDetails: "signatures" }] });
  ok(big.result.signatures.length === 1000 && big.signaturesTotal === 3000 && big.complete === false && big.truncated === true && big.returned === 1000 && big.matched === 3000, `solana-rpc: a block's 3,000 signatures are served as the first 1,000, marked partial (${big.result?.signatures?.length}, ${big.signaturesTotal})`);
  inner = async () => rpcOk({ blockHeight: 1, signatures: [SIG, SIG] });
  const small = await run("solana-rpc", { method: "getBlock", params: [250000000, { transactionDetails: "signatures" }] });
  ok(small.result.signatures.length === 2 && !("signaturesTotal" in small), "solana-rpc: a small block is served whole and unmarked");

  inner = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  const down = await errOf(() => run("solana-rpc", { method: "getSlot" }));
  ok(down?.statusCode === 503, `solana-rpc: every endpoint unreachable is the upstream 503 (got ${down?.statusCode})`);

  // The keyed provider's daily ceiling refuses before the call, uncharged.
  process.env.SOLANA_RPCS = "https://solana-mainnet.g.alchemy.com/v2/test-key";
  process.env.HARDCAP_ALCHEMY_CALLS = "0";
  _resetHardCaps();
  let reached = 0;
  inner = async () => { reached++; return rpcOk(1); };
  const capped = await errOf(() => run("solana-rpc", { method: "getSlot" }));
  ok(capped?.statusCode === 503 && capped?.hardCap === true && reached === 0, "solana-rpc: past the keyed provider's daily ceiling the call is refused with the uncharged 503 and never sent");
  process.env.HARDCAP_ALCHEMY_CALLS = "5";
  _resetHardCaps();
  const okAgain = await run("solana-rpc", { method: "getSlot" });
  ok(okAgain.result === 1 && reached === 1, "solana-rpc: under the ceiling the keyed lane answers");
  delete process.env.HARDCAP_ALCHEMY_CALLS;
  delete process.env.SOLANA_RPCS;
}

// ---- json-repair and json-lint point at the same place ---------------------
// For the common broken inputs json-repair's first fix sits where json-lint
// reports the error; the one difference, a trailing comma (json-repair at the
// comma, json-lint at the bracket after it, past any spaces), is stated in
// both descriptions.
{
  const { PARSE_TOOLS } = await import("../src/tools/parse-kit.js");
  const lint = PARSE_TOOLS.find((t) => t.slug === "json-lint"), rep = tool("json-repair");
  for (const j of ["{'a':1}", "{a:1}", '{"a":1 // c\n}', '{"a":[1,2', '{"a":NaN}', "[1,,2]", '{"a":"x\ny"}', '{"a":True}']) {
    const l = lint.handler({ json: j }).syntaxError, r = (await rep.handler({ json: j })).fixes[0];
    ok(l && r && l.offset === r.offset && l.line === r.line && l.column === r.column, `same location for ${JSON.stringify(j)} (lint ${l?.offset}, repair ${r?.offset})`);
  }
  for (const j of ["[1,2,]", '{"a":1,}', "[1, ]", "[1,\n  ]", '{"a":1 ,  }']) {
    const l = lint.handler({ json: j }).syntaxError, r = (await rep.handler({ json: j })).fixes[0];
    const bracketAfter = r ? r.offset + 1 + /^\s*/.exec(j.slice(r.offset + 1))[0].length : -1;
    ok(r && r.kind === "trailing-comma" && j[r.offset] === "," && l.offset === bracketAfter && "]}".includes(j[l.offset]), `trailing comma: repair at the comma (${r?.offset}), lint at the bracket after it (${l?.offset}) in ${JSON.stringify(j)}`);
  }
  const phrase = /For a trailing comma, json-repair points at the comma and json-lint at the bracket after it\./;
  ok(phrase.test(lint.description) && phrase.test(rep.description), "both descriptions state where each reports a trailing comma");
}
// ---- solana-rpc reads without a spaced hyphen as a dash ---------------------
{
  const t = tool("solana-rpc");
  ok(!/ - /.test(t.description), "solana-rpc's description uses no spaced hyphen as a dash");
}

// ---- id-validate's description names every type the kit checks -------------
{
  const d = tool("id-validate").description;
  const types = Object.entries(_test.ID_TYPES);
  const missing = types.filter(([, t]) => typeof t.named !== "string" || !t.named || !d.includes(t.named)).map(([k]) => k);
  ok(types.length >= 9 && missing.length === 0, `id-validate's description names each of the ${types.length} types it checks (${missing.join(", ") || "all named"})`);
}

// ---- id-validate: a type named like an object's own property is unknown ----
for (const t of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
  let e = null;
  try { tool("id-validate").handler({ value: "DEUTDEFF", type: t }); } catch (x) { e = x; }
  ok(e && e.statusCode === 400 && /"type" must be one of/.test(e.message), `id-validate type ${JSON.stringify(t)} answers 400 (${e?.statusCode})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
