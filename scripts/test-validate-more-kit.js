// id-validate, build-log-triage, json-repair (src/tools/validate-more-kit.js).
// Offline.
//
//   node scripts/test-validate-more-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

const { VALIDATE_MORE_TOOLS, _test } = await import("../src/tools/validate-more-kit.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => VALIDATE_MORE_TOOLS.find((t) => t.slug === slug);
const run = (slug, input) => tool(slug).handler(input);
const status = async (fn) => { try { await fn(); return 200; } catch (e) { return e.statusCode ?? "throw:" + e.message; } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- free tier and wallet-only placement -----------------------------------
for (const s of ["id-validate", "build-log-triage", "json-repair"]) ok(FREE_TIER_SLUGS.has(s) && !WALLET_ONLY_SLUGS.has(s), `${s} is on the free tier`);
ok(!FREE_TIER_SLUGS.has("solana-rpc") && !WALLET_ONLY_SLUGS.has("solana-rpc"), "solana-rpc is retired: on no tier list");

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

// ---- the descriptions claim only what the tools do ----
{
  const id = tool("id-validate").description;
  ok(id.includes("the check digits where the type has them (BIC and NINO carry none)") && !/^Check the format and check digits of/.test(id), "id-validate: check digits are claimed only where a type has them");
  const jr = tool("json-repair").description;
  ok(jr.includes(`list its fixes with their line, column and offset (the first ${_test.FIXES_SHOWN} in full; fixCount and fixKinds count all)`) && !/list every fix/.test(jr), "json-repair: the listed fixes are bounded and the counts cover all");
}

// ---- build-log-triage reads a repeated line once ----
{
  let best = Infinity;
  const log = "a\n".repeat(49_999);
  for (let i = 0; i < 3; i++) { const t = performance.now(); _test.buildLogTriage({ log }); best = Math.min(best, performance.now() - t); }
  ok(best < 40, `build-log-triage: 49,999 repeated lines in under 40 ms (${best.toFixed(1)} ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
