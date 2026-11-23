// The MPP snippets the docs publish are run as written: each JavaScript
// block that pays with mppx is taken from its file, pointed at a local paid
// server (the MPP shim over a stub facilitator) and must come back paid. A
// reader copies these blocks; a block that cannot sign (an evm method given
// no currencies has no token name and version to sign with) fails here, where
// a suite that builds its own client would pass.
//
// Nothing leaves this process: every fetch to a host other than the local
// server or its stub facilitator fails the run.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as mppxClient from "mppx/client";
import * as viemAccounts from "viem/accounts";
import { Agent402, normalizeEvmKey } from "../client/index.js";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// ---- the published blocks ------------------------------------------------------
/** Every fenced js block of a markdown file that imports mppx/client. */
const mppBlocks = (text) => [...text.matchAll(/```(?:js|javascript|ts|typescript)\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /from "mppx\/client"/.test(b));
/** The argument text of each `evm.charge(...)` call in `code` (balanced parentheses). */
function evmChargeCalls(code) {
  const out = [];
  for (let at = code.indexOf("evm.charge("); at >= 0; at = code.indexOf("evm.charge(", at + 1)) {
    let depth = 0, end = -1;
    for (let k = at + "evm.charge".length; k < code.length && k < at + 2000; k++) {
      if (code[k] === "(") depth++;
      else if (code[k] === ")" && --depth === 0) { end = k; break; }
    }
    if (end > 0) out.push(code.slice(at + "evm.charge(".length, end));
  }
  return out;
}
const DOCS = ["README.md", "client/README.md", "wiki/Paying-with-MPP.md", "wiki/Paying-with-x402.md"];
// Files that carry the same client code outside a markdown block.
const SOURCES = ["src/integration-pages.js", "src/how-to-pay.js", "src/learn.js", "src/mpp-flagship.js", "src/skill-md.js"];
const blocks = DOCS.flatMap((f) => mppBlocks(read(f)).map((code) => ({ file: f, code })));
ok(DOCS.every((f) => blocks.some((b) => b.file === f)), `each doc publishes an mppx block (${DOCS.filter((f) => !blocks.some((b) => b.file === f)).join(", ") || "all four"})`);
const calls = [...blocks.flatMap((b) => evmChargeCalls(b.code).map((args) => ({ file: b.file, args }))), ...SOURCES.flatMap((f) => evmChargeCalls(read(f)).map((args) => ({ file: f, args })))];
ok(calls.length >= 9 && [...DOCS, ...SOURCES].every((f) => calls.some((c) => c.file === f)), `every file's evm.charge call is read (${calls.length} calls)`);
// A file that gains an evm.charge snippet is read here too: every tracked file
// outside scripts/ and the package test that names the call is on a list above.
{
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["grep", "-l", "evm\\.charge(", "--", ".", ":!scripts", ":!client/test.js"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter(Boolean).sort();
  const listed = [...DOCS, ...SOURCES].sort();
  ok(JSON.stringify(tracked) === JSON.stringify(listed), `every tracked file that publishes an evm.charge call is read by this suite (unlisted: ${tracked.filter((f) => !listed.includes(f)).join(", ") || "none"}; gone: ${listed.filter((f) => !tracked.includes(f)).join(", ") || "none"})`);
}
const noCurrencies = calls.filter((c) => !/\bcurrencies\s*:\s*\[[^\]]*evm\.assets\.base\.USDC[^\]]*\]/.test(c.args));
ok(noCurrencies.length === 0, `every published evm.charge call passes currencies, Base USDC among them (${noCurrencies.map((c) => `${c.file}: evm.charge(${c.args.trim().slice(0, 40)})`).join("; ") || "none without"})`);
const noCelo = calls.filter((c) => !/evm\.assets\.celo\.USDC/.test(c.args));
ok(noCelo.length === 0, `every published evm.charge call lists Celo USDC too, the other network the evm method is offered on (${noCelo.map((c) => c.file).join(", ") || "none without"})`);
ok(calls.every((c) => { try { return new Function("evm", "account", "KEY", "privateKeyToAccount", `return [${c.args}]`)(mppxClient.evm, {}, "0x", () => ({})).length === 1; } catch { return false; } }) && typeof mppxClient.evm.assets.base.USDC?.transfer?.name === "string" && typeof mppxClient.evm.assets.celo.USDC?.transfer?.version === "string", "the assets each call names exist in the installed mppx and carry the token name and version a signature needs");
ok(evmChargeCalls("x evm.charge({ a: f(1), b: [g(2)] }) y evm.charge({ account })").join("|") === "{ a: f(1), b: [g(2)] }|{ account }" && mppBlocks("```js\nimport { evm } from \"mppx/client\";\n```\n```js\nother\n```").length === 1, "control: the reader finds each call's whole argument and only the mppx blocks");

// ---- a local paid server --------------------------------------------------------
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;
const fac = { verify: 0, settle: 0 };
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: TX, network: "eip155:8453", payer }); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const F = `http://127.0.0.1:${facilitator.address().port}`;
const srv = await bootServer({
  stores: "doc-mpp-snippets",
  env: {
    FREE_MODE: "", NODE_ENV: "test", WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: F, AGENT402_BASE_RPC: `${F}/rpc`, FACILITATOR_GAS_CHECK: "off", MPP_SECRET_KEY: "doc-mpp-snippets-test",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", CDP_SQL_API_KEY_ID: "", CDP_SQL_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
    TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "", REDIS_URL: "", TARGET_URL: "",
    STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
  },
});
const B = srv.url;

// ---- run each block as written -------------------------------------------------
const realFetch = globalThis.fetch;
const left = [];
const localOnly = (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(`${B}/`) && !url.startsWith(`${F}/`)) { left.push(url); return Promise.reject(new Error(`a doc snippet reached ${url}`)); }
  return realFetch(input, init);
};
// The SDK's default base URL is production: a snippet's client is pointed here.
class LocalAgent402 extends Agent402 { constructor(o = {}) { super({ ...o, baseUrl: B }); } }
const AsyncFunction = (async () => {}).constructor;
const KNOWN = { "mppx/client": mppxClient, "viem/accounts": viemAccounts, "agent402-client": { Agent402: LocalAgent402, normalizeEvmKey } }; // the workspace client: the version the docs name, published with them
/** Run one published block: its imports bound to the installed modules, the
 *  site's URL to the local server, its key to a throwaway one. Returns the
 *  values of the names it declares that a reader would look at. */
async function runBlock(code, { strip = false } = {}) {
  const bound = {};
  let body = code.replace(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?[ \t]*$/gm, (line, names, mod) => {
    if (!KNOWN[mod]) throw new Error(`the block imports ${mod}, which this suite does not bind`);
    for (const n of names.split(",").map((x) => x.trim()).filter(Boolean)) { if (!(n in KNOWN[mod])) throw new Error(`${mod} has no export ${n}`); bound[n] = KNOWN[mod][n]; }
    return "";
  });
  if (/^\s*import\s/m.test(body)) throw new Error("the block has an import this suite does not read");
  body = body.replaceAll("https://agent402.tools", B);
  // The fault the docs had: the same block with the currencies taken out.
  if (strip) body = body.replace(/,\s*currencies\s*:\s*\[[^\]]*\]/g, "");
  if (!("Agent402" in bound) && /\bAgent402\b/.test(body)) bound.Agent402 = LocalAgent402;
  const KEY = viemAccounts.generatePrivateKey();
  process.env.AGENT_KEY = KEY;
  globalThis.fetch = localOnly;
  const names = ["res", "verdict", "out"].filter((n) => new RegExp(`\\bconst ${n}\\b`).test(body));
  try {
    const fn = new AsyncFunction(...Object.keys(bound), "KEY", "console", `${body}\nreturn { ${names.join(", ")} };`);
    return await fn(...Object.values(bound), KEY, { log: () => {}, warn: () => {}, error: () => {} });
  } finally { globalThis.fetch = realFetch; delete process.env.AGENT_KEY; }
}

try {
  for (const { file, code } of blocks) {
    const before = { ...fac };
    let got = null, err = null;
    try { got = await runBlock(code); } catch (e) { err = e; }
    const res = got?.res;
    const paidOk = res ? res.status === 200 && !!res.headers?.get?.("payment-receipt") : got && (got.verdict || got.out) && typeof (got.verdict || got.out) === "object";
    ok(!err && paidOk && fac.settle === before.settle + 1 && fac.verify === before.verify + 1, `${file}: the published mppx block pays the local server as written (${err ? `threw: ${String(err.message).slice(0, 160)}` : res ? `HTTP ${res.status}` : "SDK call answered"}; +${fac.verify - before.verify} verify, +${fac.settle - before.settle} settle)`);
  }
  // Control: with the currencies taken out the same block cannot pay, so the runs above are what catch it.
  {
    const first = blocks.find((b) => b.file === "README.md");
    const before = { ...fac };
    let got = null, err = null;
    try { got = await runBlock(first.code, { strip: true }); } catch (e) { err = e; }
    ok((err !== null || got?.res?.status !== 200) && fac.settle === before.settle, `control: the README block with no currencies does not pay (${err ? String(err.message).slice(0, 90) : `HTTP ${got?.res?.status}`})`);
  }
  ok(left.length === 0, `no snippet reached a host other than the local server (${left.slice(0, 3).join(", ") || "none"})`);
} finally {
  globalThis.fetch = realFetch;
  await srv.stop();
  await new Promise((r) => { facilitator.closeAllConnections?.(); facilitator.close(() => r()); });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
