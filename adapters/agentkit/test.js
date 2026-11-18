// Smoke test for agent402-agentkit. Spawns its own paywalled server
// (X402_SYNC_ON_START=false so no facilitator is contacted; proof-of-work
// bypasses settlement) and drives the three actions the way AgentKit's
// customActionProvider does: schema.parse(args), then invoke(args) or
// invoke(walletProvider, args). @coinbase/agentkit is stubbed to the one
// export the adapter uses, so the test never pulls its dependency tree.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}
const stubDir = join(HERE, "node_modules", "@coinbase", "agentkit");
if (!existsSync(join(stubDir, "package.json"))) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({ name: "@coinbase/agentkit", version: "0.0.0-stub", type: "module", main: "index.js" }));
  writeFileSync(join(stubDir, "index.js"), `
    export function customActionProvider(actions) { return { __stub: true, name: "custom", actions }; }
  `);
}

const { agent402Actions, agent402ActionProvider, payFetchFor, resolveMaxPerCallUsd, DEFAULT_MAX_PER_CALL_USD } = await import("./index.js");

const PORT = 3087;
const BASE = process.env.AGENT402_BASE_URL || `http://localhost:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn("node", ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
      POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(m); pass++; console.log(`ok - ${m}`); };

async function main() {
  const actions = await agent402Actions({ baseUrl: BASE });
  ok(actions.map((a) => a.name).join(",") === "agent402_find,agent402_call,agent402_about", "three actions in order: find, call, about");
  for (const a of actions) ok(typeof a.schema?.parse === "function" && typeof a.invoke === "function" && a.description.length > 40, `${a.name}: zod schema + invoke + description`);
  const [find, call, about] = actions;
  ok(find.invoke.length !== 2 && call.invoke.length === 2 && about.invoke.length !== 2, "invoke arity tells AgentKit which actions take the wallet provider (call does, find/about do not)");

  // find: free discovery, parsed the way customActionProvider parses it
  const found = JSON.parse(await find.invoke(find.schema.parse({ task: "sha256 hash of a string", k: 3 })));
  ok(Array.isArray(found.results) && found.results.some((r) => r.slug === "hash"), "agent402_find resolves 'sha256 hash of a string' to the hash tool");
  let threw = false; try { find.schema.parse({ task: "" }); } catch { threw = true; }
  ok(threw, "agent402_find schema refuses an empty task");

  // call with NO wallet provider: proof-of-work pays the free-tier tool
  const out = JSON.parse(await call.invoke(null, call.schema.parse({ slug: "hash", params: { text: "hello world", algo: "sha256" } })));
  const want = createHash("sha256").update("hello world").digest("hex");
  ok((out.hex || out.digest || out.hash) === want, "agent402_call paid the free tier with proof-of-work and returned sha256('hello world')");

  // call with a wallet provider shaped like AgentKit's EVM providers: the
  // paying fetch is built from toSigner() (no paid call is made here)
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount("0x" + "11".repeat(32));
  const walletProvider = { toSigner: () => account, readContract: async () => 0n, getNetwork: () => ({ protocolFamily: "evm", networkId: "base-mainnet" }) };
  const pf = await payFetchFor(walletProvider);
  ok(typeof pf === "function", "payFetchFor builds an x402-paying fetch from an EVM wallet provider's toSigner()");
  ok((await payFetchFor({})) === undefined && (await payFetchFor(null)) === undefined, "no toSigner() -> no paying fetch (proof-of-work only), never a throw");
  const out2 = JSON.parse(await call.invoke(walletProvider, { slug: "hash", params: { text: "hello world", algo: "sha256" } }));
  ok((out2.hex || out2.digest || out2.hash) === want, "with a wallet provider the free-tier call still pays by proof-of-work and returns the same result");

  // about: free
  // Spend ceilings hold ACROSS invokes: one client per wallet for the life of
  // the actions (0.1.2). A stub seller answers a $0.003 wallet-only tool by
  // credits key; under a $0.005 daily ceiling the second invoke is refused
  // before any request leaves the process. No wallet is funded.
  {
    const seen = [];
    const stub = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      const j = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [{ slug: "search", method: "POST", path: "/api/search", price: "$0.003", computePayable: false }] });
      if (!req.headers.authorization) return j(402, { error: "Payment required" });
      j(200, { results: [{ url: "https://x402.org" }] });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const STUB = `http://127.0.0.1:${stub.address().port}`;
    const KEY = "a402_" + "k".repeat(40);
    const [, callK] = await agent402Actions({ baseUrl: STUB, creditsKey: KEY, dailyLimitUsd: 0.005, maxPerCallUsd: 0.004 });
    const paid = () => seen.filter((x) => x.url.startsWith("/api/search") && x.auth === `Bearer ${KEY}`).length;
    const first = JSON.parse(await callK.invoke(null, { slug: "search", params: { q: "x402" } }));
    ok(first.results?.[0]?.url === "https://x402.org" && paid() === 1, "call 1 under the daily ceiling settles by credits key (stub saw one paid request)");
    let refused = null;
    try { await callK.invoke(null, { slug: "search", params: { q: "mpp" } }); } catch (e) { refused = String(e?.message || e); }
    ok(refused && /dailyLimitUsd|24h spend/.test(refused) && paid() === 1, "call 2 is refused by the DAILY ceiling with no request sent: the ledger survived across invokes");
    stub.close();
  }

  // The per-call ceiling: $5 by default, 0 or "off" for none, and a value that
  // does not parse keeps the default (one warning each), never none.
  {
    const w = [];
    ok(DEFAULT_MAX_PER_CALL_USD === 5 && resolveMaxPerCallUsd(undefined, (m) => w.push(m)) === 5 && resolveMaxPerCallUsd(null, (m) => w.push(m)) === 5 && w.length === 0, "the default per-call ceiling is $5, with no warning");
    ok(resolveMaxPerCallUsd(0) === null && resolveMaxPerCallUsd("0") === null && resolveMaxPerCallUsd("off") === null && resolveMaxPerCallUsd(" OFF ") === null && resolveMaxPerCallUsd("0.5") === 0.5 && resolveMaxPerCallUsd(7) === 7, "0 or off is no ceiling; a USD number sets it");
    const bad = ["abc", -1, "-1", Number.NaN, "", " ", "1e999", {}];
    ok(bad.every((v) => resolveMaxPerCallUsd(v, (m) => w.push(m)) === 5) && w.length === bad.length, `a malformed value keeps the $5 default and warns once each (${w.length} warnings)`);
  }

  // The per-call ceiling holds on the payment that is SIGNED. A stub seller
  // quotes $0.01 to the unpaid preflight and $5 (5000000 base units of USDC,
  // beside a decimals hint of 18) to the request the wallet signs for. The
  // wallet is a throwaway key; the stub records any signature it receives.
  {
    const seen = { unpaid: 0, signed: 0 };
    let quote = 5000000;
    const offer = (amount) => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/api/dear", description: "dear", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", decimals: 18 } }],
    })).toString("base64");
    const stub = createServer((req, res) => {
      const j = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [{ slug: "dear", method: "POST", path: "/api/dear", price: "$0.01", computePayable: false }] });
      req.resume();
      if (req.headers["payment-signature"] || req.headers["x-payment"]) { seen.signed++; return j(200, { ok: true }); }
      seen.unpaid++;
      return j(402, {}, { "payment-required": offer(seen.unpaid === 1 ? 10000 : quote) });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const STUB = `http://127.0.0.1:${stub.address().port}`;
    const [, callW] = await agent402Actions({ baseUrl: STUB, maxPerCallUsd: 1 });
    let refused = null;
    try { await callW.invoke(walletProvider, { slug: "dear", params: { q: "x" } }); } catch (e) { refused = e; }
    ok(seen.unpaid === 2, `the preflight and the paid request each drew a 402 (saw ${seen.unpaid})`);
    ok(seen.signed === 0, "the $5 payment the paid request asked for was never signed under a $1 ceiling the caller set");
    ok(refused?.name === "SpendingLimitError" && refused.atSigning === true, `the refusal is a SpendingLimitError at signing (${refused?.message})`);
    // The default per-call ceiling is $5: the same $5 payment is signed and
    // paid with no setting, and a $6 one is refused before signing.
    const [, callDefault] = await agent402Actions({ baseUrl: STUB });
    const atCeiling = JSON.parse(await callDefault.invoke(walletProvider, { slug: "dear", params: { q: "y" } }));
    ok(atCeiling.ok === true && seen.signed === 1, `with no setting a $5 call (at the $5 default) is paid (signed ${seen.signed})`);
    quote = 6000000;
    let over = null;
    try { await callDefault.invoke(walletProvider, { slug: "dear", params: { q: "z" } }); } catch (e) { over = e; }
    ok(over?.name === "SpendingLimitError" && seen.signed === 1, `the $5 default refuses a $6 payment before signing (signed ${seen.signed}; ${over?.message})`);
    ok(/\$6\b/.test(over?.message || "") && /maxPerCallUsd/.test(over?.message || "") && /\$5/.test(over?.message || "") && /0 or "off"/.test(over?.message || ""), `the refusal names the price, the ceiling and how to raise or turn it off (${over?.message})`);
    // 0 and "off" turn the ceiling off: the $6 payment is signed.
    for (const v of [0, "off"]) {
      const before = seen.signed;
      const [, callOff] = await agent402Actions({ baseUrl: STUB, maxPerCallUsd: v });
      const r = JSON.parse(await callOff.invoke(walletProvider, { slug: "dear", params: { q: String(v) } }));
      ok(r.ok === true && seen.signed === before + 1, `maxPerCallUsd ${JSON.stringify(v)} turns the ceiling off and the $6 call is paid`);
    }
    // A value that does not parse keeps the $5 default and is named once.
    for (const v of ["abc", -1, Number.NaN, "", "5 usd"]) {
      const warned = [];
      const origErr = console.error;
      console.error = (...a) => warned.push(a.join(" "));
      let refusedBad = null;
      try {
        const [, callBad] = await agent402Actions({ baseUrl: STUB, maxPerCallUsd: v });
        await callBad.invoke(walletProvider, { slug: "dear", params: { q: "bad" } });
      } catch (e) { refusedBad = e; } finally { console.error = origErr; }
      ok(refusedBad?.name === "SpendingLimitError" && seen.signed === 3 && /\$5/.test(refusedBad?.message || ""), `maxPerCallUsd ${JSON.stringify(String(v))} keeps the $5 ceiling (${refusedBad?.message})`);
      ok(warned.filter((m) => /maxPerCallUsd=.* is not a USD amount, 0 or "off"; keeping the default \$5 per-call ceiling/.test(m)).length === 1, `maxPerCallUsd ${JSON.stringify(String(v))} is named once on stderr (${warned.join(" | ")})`);
    }
    stub.close();
  }

  const ab = JSON.parse(await about.invoke({}));
  ok(ab.tools > 100 && ab.freeTier > 10 && ab.discover.includes("/api/find"), `agent402_about reports ${ab.tools} tools, ${ab.freeTier} free-tier`);

  // the provider wrapper hands the same actions to AgentKit's customActionProvider
  const provider = await agent402ActionProvider({ baseUrl: BASE });
  ok(provider.__stub === true && provider.actions.length === 3 && provider.actions[1].name === "agent402_call", "agent402ActionProvider wraps the three actions with @coinbase/agentkit's customActionProvider");

  console.log(`PASS - agent402-agentkit: ${pass} checks`);
}

main().then(() => { if (proc) proc.kill(); process.exit(0); }).catch((e) => { console.error("FAIL:", e); if (proc) proc.kill(); process.exit(1); });
