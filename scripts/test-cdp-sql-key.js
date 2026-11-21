// The onchain SQL reads sign with their own CDP key pair when one is set
// (CDP_SQL_API_KEY_ID + CDP_SQL_API_KEY_SECRET), and with the main pair when
// it is not; every other CDP call keeps the main pair. Offline: fetch is a
// stub, every key is generated here, and each request's token is verified
// against the public half of the pair it should have been signed with.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

for (const k of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_SQL_API_KEY_ID", "CDP_SQL_API_KEY_SECRET"]) delete process.env[k];
const kit = await import("../src/tools/cdp-kit.js");
const { CDP_TOOLS, cdpSql, cdpConfigured, cdpCredentialsFor, _resetSqlPacerForTest, _setQueryHealthForTest, _resetCdpLogThrottleForTest } = kit;
const { redactSecrets } = await import("../src/tools/redact.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => CDP_TOOLS.find((t) => t.slug === slug);
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }); return { pem: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey }; };
const MAIN = { id: "organizations/main-org/apiKeys/main-key-0001", ...pair() };
const SQL = { id: "organizations/sql-org/apiKeys/sql-key-0002", ...pair() };
const setEnv = (main, sql) => {
  const put = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  put("CDP_API_KEY_ID", main?.id); put("CDP_API_KEY_SECRET", main?.pem);
  put("CDP_SQL_API_KEY_ID", sql?.id); put("CDP_SQL_API_KEY_SECRET", sql?.pem);
};

const realFetch = globalThis.fetch;
const calls = [];
let status = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const auth = String(new Headers(init.headers || {}).get("authorization") || "");
  calls.push({ path: u.pathname, token: auth.replace(/^Bearer /, "") });
  const body = u.pathname.endsWith("/schema") ? { tables: [] } : u.pathname.includes("/token-balances/") ? { balances: [] } : { result: [{ n: 1 }] };
  return new Response(JSON.stringify(status === 200 ? body : { errorMessage: `key ${process.env.CDP_SQL_API_KEY_ID} refused` }), { status, headers: { "content-type": "application/json" } });
};
/** Which pair signed `token`: "main", "sql" or null, by kid AND by signature. */
const signer = (token) => {
  const [h, c, s] = token.split(".");
  if (!h || !c || !s) return null;
  const kid = JSON.parse(Buffer.from(h, "base64url").toString()).kid;
  for (const [name, k] of [["main", MAIN], ["sql", SQL]]) {
    if (kid === k.id && createVerify("SHA256").update(`${h}.${c}`).verify({ key: k.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))) return name;
  }
  return null;
};
const subOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
const fresh = () => { calls.length = 0; status = 200; _resetSqlPacerForTest(0); _setQueryHealthForTest(true); _resetCdpLogThrottleForTest?.(); };
const sqlRun = () => tool("onchain-sql").handler({ sql: "SELECT block_number FROM base.blocks LIMIT 1" });
const schema = () => tool("onchain-sql-schema").handler({});
const balances = () => tool("wallet-balances").handler({ address: "0x" + "1".repeat(40), network: "base" });
const by = (re) => calls.filter((c) => re.test(c.path));

try {
  // Both pairs set: the SQL reads sign with the SQL pair, everything else with the main pair.
  setEnv(MAIN, SQL); fresh();
  await sqlRun(); await schema(); await cdpSql("SELECT 1"); await balances();
  const q = by(/\/data\/query\/run$/), sc = by(/\/data\/query\/schema$/), tb = by(/\/token-balances\//);
  ok(q.length >= 2 && q.every((c) => signer(c.token) === "sql") && q.every((c) => subOf(c.token) === SQL.id), `a buyer's query and this server's own SQL read sign with the SQL pair (${q.map((c) => signer(c.token)).join()})`);
  ok(sc.length === 1 && signer(sc[0].token) === "sql", "the query schema read signs with the SQL pair");
  ok(tb.length === 1 && signer(tb[0].token) === "main" && subOf(tb[0].token) === MAIN.id, "a call outside the SQL API keeps the main pair");
  ok(cdpCredentialsFor("/platform/v2/data/query/run").source === "sql" && cdpCredentialsFor("/platform/v2/data/query/schema").source === "sql" && cdpCredentialsFor("/platform/v2/evm/faucet").source === "main" && cdpCredentialsFor("/platform/v2/onramp/sessions").source === "main" && cdpCredentialsFor("/platform/v2/data/queryx").source === "main", "only the SQL API paths take the SQL pair");

  // No SQL pair: every call signs with the main pair, as before.
  setEnv(MAIN, null); fresh();
  await sqlRun(); await schema(); await balances();
  ok(calls.length >= 3 && calls.every((c) => signer(c.token) === "main"), `with no SQL pair every call signs with the main pair (${calls.map((c) => signer(c.token)).join()})`);

  // Half a pair is not a pair: the main pair signs, never a mix of the two.
  for (const [label, half] of [["id only", { id: SQL.id, pem: null }], ["secret only", { id: null, pem: SQL.pem }], ["blank id", { id: "   ", pem: SQL.pem }]]) {
    setEnv(MAIN, half); fresh();
    await sqlRun();
    ok(by(/\/data\/query\/run$/).every((c) => signer(c.token) === "main") && cdpCredentialsFor("/platform/v2/data/query/run").source === "main", `a SQL pair with ${label} falls back to the main pair whole`);
  }

  // The SQL pair alone serves the SQL reads; calls that need the main pair say not configured.
  setEnv(null, SQL); fresh();
  await sqlRun();
  ok(by(/\/data\/query\/run$/).every((c) => signer(c.token) === "sql") && cdpConfigured() === true, "the SQL pair alone signs the SQL reads");
  let e = null; try { await balances(); } catch (x) { e = x; }
  ok(e?.statusCode === 503 && by(/\/token-balances\//).length === 0, `a call outside the SQL API with no main pair is the env-gate 503, nothing sent (${e?.statusCode})`);
  setEnv(null, null); fresh();
  e = null; try { await sqlRun(); } catch (x) { e = x; }
  ok(e?.statusCode === 503 && calls.length === 0 && cdpConfigured() === false, "no pair at all: the env-gate 503");

  // Neither key reaches an error message or a log line.
  setEnv(MAIN, SQL); fresh(); status = 500;
  const realWarn = console.warn, realErr = console.error, realLog = console.log;
  const printed = [];
  console.warn = (...a) => printed.push(a.map(String).join(" ")); console.error = console.warn;
  let err = null;
  try { await sqlRun(); } catch (x) { err = x; } finally { console.warn = realWarn; console.error = realErr; console.log = realLog; }
  const text = `${err?.message}\n${printed.join("\n")}`;
  ok(err && printed.length > 0 && !text.includes(SQL.id) && !text.includes("sql-key-0002") && !text.includes(MAIN.id) && !text.includes(SQL.pem.slice(30, 60)), `a failure the upstream words with the key id prints neither key (${printed.length} lines)`);
  ok(!redactSecrets(`x ${SQL.id} y ${SQL.pem} z`).includes("sql-key-0002") && !redactSecrets(SQL.pem).includes(SQL.pem.split("\n")[1]), "both SQL variables are redacted by name wherever a secret is scrubbed");
} finally {
  globalThis.fetch = realFetch;
  setEnv(null, null);
}

// Test boots blank the SQL pair with the main one, so a developer's shell never lends a server its key.
for (const f of ["lib/paid-boot.js", "lib/paid-wires-rig.js"]) {
  const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  ok(/CDP_SQL_API_KEY_ID: ""/.test(src) && /CDP_SQL_API_KEY_SECRET: ""/.test(src), `scripts/${f} blanks the SQL pair beside the main pair`);
}
// Both variables have a purpose line in the configuration reference.
const cfg = readFileSync(new URL("../docs/configuration.json", import.meta.url), "utf8");
ok(/"CDP_SQL_API_KEY_ID": "[^"]{20,}"/.test(cfg) && /"CDP_SQL_API_KEY_SECRET": "[^"]{20,}"/.test(cfg), "docs/configuration.json describes both variables");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
