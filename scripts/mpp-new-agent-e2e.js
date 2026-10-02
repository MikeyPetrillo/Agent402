// A brand-new agent's first session on the Tempo MPP rail, end to end, against
// production. Everything the internal canaries skip because the burner already
// knows the way: a FRESH wallet, discovery from the public surfaces, the
// published quickstart snippet run as written, a paid call over the hosted MCP
// connector, a deliberately bad body, and the leftover funds sent back.
//
// Why: real first sessions showed failures no canary sees - a refusal that said
// only "Payment verification failed", a bad body that waited on relay
// validation before its 400, a refusal with no log line. The canaries pay from
// a warm wallet down paths they already know; this does what a stranger does.
//
// Money: at most FUND_USD (<= $0.30) leaves the canary burner for the fresh
// wallet; buys are capped at BUDGET_USD total (<= $0.25) and MAX_EACH_USD
// ($0.01) per call; the payments go to our own payTo. What is left is sent
// back to the burner at the end, minus the transfer fee. Every request carries
// the POW_SECRET-signed heartbeat token, so every sale is booked as internal.
//
//   BURNER_KEY=0x... POW_SECRET=... node scripts/mpp-new-agent-e2e.js
//
// Exit 0 = every check passed; 1 = a check failed; 2 = refused to start.
import { createHmac } from "node:crypto";
import { createPublicClient, createWalletClient, http, encodeFunctionData, getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { tempo as tempoChain } from "viem/tempo/chains";
import { prepareTransactionRequest, signTransaction, sendRawTransaction, waitForTransactionReceipt } from "viem/actions";
import { Fetch, evm, tempo } from "mppx/client";
import { Challenge, Receipt } from "mppx";
import { McpClient } from "mppx/mcp/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
const HARD_FUND_CAP = 0.30;
const HARD_BUDGET_CAP = 0.25;
const FUND_USD = Math.min(Number(process.env.FUND_USD || HARD_FUND_CAP), HARD_FUND_CAP);
const BUDGET_USD = Math.min(Number(process.env.BUDGET_USD || HARD_BUDGET_CAP), HARD_BUDGET_CAP, FUND_USD);
const MAX_EACH_USD = Math.min(Number(process.env.MAX_EACH_USD || 0.01), 0.01);
const TARGET_P95_MS = 6000;
const ROW_FAIL_MS = 15000;

const die = (m) => { console.error(`mpp-new-agent-e2e: ${m}`); process.exit(2); };
const burnerPk = (process.env.BURNER_KEY || "").trim();
if (!burnerPk) die("no BURNER_KEY");
const powSecret = (process.env.POW_SECRET || "").trim();
// Without the token every buy would be booked as outside revenue. Refuse.
if (!powSecret) die("no POW_SECRET - requests could not be marked internal");
if (!(FUND_USD > 0) || !(BUDGET_USD > 0)) die("FUND_USD and BUDGET_USD must be positive");

const hb = () => createHmac("sha256", powSecret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (units) => (Number(units) / 1e6).toFixed(6);

const burner = privateKeyToAccount(burnerPk.startsWith("0x") ? burnerPk : `0x${burnerPk}`);
const fresh = privateKeyToAccount(generatePrivateKey());   // never persisted; leftovers go back below
const pub = createPublicClient({ chain: tempoChain, transport: http(RPC) });
const ERC20 = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const balanceOf = (a) => pub.readContract({ address: USDC_E, abi: ERC20, functionName: "balanceOf", args: [a] });

async function sendUsdcE(fromAccount, to, units) {
  const wallet = createWalletClient({ account: fromAccount, chain: tempoChain, transport: http(RPC) });
  const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(to), units] });
  // Prepared, never hand-rolled (an unprepared Tempo tx is signed with a zero
  // gas price); the fee is paid in USDC.e, the only token a fresh wallet holds.
  const prepared = await prepareTransactionRequest(wallet, { account: fromAccount, chainId: tempoChain.id, calls: [{ to: USDC_E, data }], feeToken: USDC_E });
  const hash = await sendRawTransaction(wallet, { serializedTransaction: await signTransaction(wallet, prepared) });
  const receipt = await waitForTransactionReceipt(pub, { hash });
  if (receipt.status !== "success") throw new Error(`transfer ${hash} reverted`);
  return hash;
}

const rows = [];
function record(step, ok, ms, note) {
  rows.push({ step, ok, ms, note: String(note || "").replace(/\s+/g, " ").slice(0, 110) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ms != null ? ` (${ms} ms)` : ""}  ${note || ""}`);
}
let spent = 0;

async function main() {
  console.log(`target ${TARGET}`);
  console.log(`fresh wallet ${fresh.address} (generated for this run)`);

  // --- (b) fund the fresh wallet ------------------------------------------
  const fundUnits = BigInt(Math.round(FUND_USD * 1e6));
  const burnerBal = await balanceOf(burner.address);
  if (burnerBal < fundUnits + 1_000_000n) die(`burner holds ${usd(burnerBal)} USDC.e; needs ${usd(fundUnits)} plus a $1 floor`);
  const fundTx = await sendUsdcE(burner, fresh.address, fundUnits);
  const startBal = await balanceOf(fresh.address);
  record("fund fresh wallet", startBal === fundUnits, null, `${usd(startBal)} USDC.e tx ${fundTx}`);
  if (startBal !== fundUnits) return;

  // --- (c) discovery the way a new agent finds us --------------------------
  {
    const t = Date.now();
    const r = await fetch(`${TARGET}/llms.txt`);
    const txt = await r.text();
    record("discover: /llms.txt names MPP and Tempo", r.ok && /MPP/i.test(txt) && /tempo/i.test(txt), Date.now() - t, `${txt.length} chars`);
  }
  {
    const t = Date.now();
    const r = await fetch(`${TARGET}/openapi.json`);
    const doc = await r.json().catch(() => null);
    let tempoOffers = 0;
    for (const ops of Object.values(doc?.paths || {})) for (const op of Object.values(ops || {})) {
      if ((op?.["x-payment-info"]?.offers || []).some((o) => o.method === "tempo")) tempoOffers++;
    }
    record("discover: /openapi.json x-payment-info offers tempo", tempoOffers > 0, Date.now() - t, `${tempoOffers} operations offer tempo/charge`);
  }
  {
    const t = Date.now();
    const r = await fetch(`${TARGET}/api/uuid`, { headers: { "X-Heartbeat-Token": hb() } });
    let chs = [];
    try { chs = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": r.headers.get("www-authenticate") || "" })); } catch { chs = []; }
    const tempoCh = chs.find((c) => c.method === "tempo" && c.request?.currency?.toLowerCase() === USDC_E.toLowerCase());
    record("discover: unpaid 402 carries a USDC.e tempo challenge", r.status === 402 && !!tempoCh, Date.now() - t, tempoCh ? `amount ${tempoCh.request.amount}, first method ${chs[0]?.method}` : `status ${r.status}, methods ${chs.map((c) => c.method).join(",")}`);
  }

  // --- (d) the published quickstart, as written ----------------------------
  // The snippet on /learn, the skill file and the llms guide:
  //   Fetch.from({ methods: [tempo.charge({ account }), evm.charge({ account })] })
  //   POST /api/hash {"text":"hello world"}
  // The only addition is the heartbeat header that books this run as ours.
  const mppFetch = Fetch.from({ methods: [tempo.charge({ account: fresh }), evm.charge({ account: fresh })] });
  async function buy(step, method, path, body, priceUsd, check) {
    if (priceUsd > MAX_EACH_USD) return record(step, false, null, `price $${priceUsd} over the $${MAX_EACH_USD} per-call cap - not bought`);
    if (spent + priceUsd > BUDGET_USD + 1e-9) return record(step, false, null, `budget $${BUDGET_USD} would be exceeded - not bought`);
    const t = Date.now();
    let res, json = null, text = "";
    try {
      const url = method === "GET" && body ? `${TARGET}${path}?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]))}` : `${TARGET}${path}`;
      res = await mppFetch(url, {
        method,
        headers: { "X-Heartbeat-Token": hb(), ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
      });
      text = await res.text();
      try { json = JSON.parse(text); } catch { /* not json */ }
    } catch (e) {
      return record(step, false, Date.now() - t, `threw: ${e?.message || e}`);
    }
    const ms = Date.now() - t;
    const receipt = res.headers.get("payment-receipt");
    let ref = null;
    try { ref = receipt ? Receipt.deserialize(receipt).reference : null; } catch { ref = null; }
    if (res.status === 200 && ref) spent += priceUsd;
    const useful = check ? check(json, text) : (json && typeof json === "object" && Object.keys(json).length > 0);
    const ok = res.status === 200 && !!ref && !!useful && ms <= ROW_FAIL_MS;
    record(step, ok, ms, ok ? `receipt ${String(ref).slice(0, 18)}...` : `status ${res.status}, receipt ${ref ? "yes" : "no"}, useful ${!!useful}: ${(json?.detail || json?.error || text).slice(0, 80)}`);
    return { ms, ok };
  }
  const latencies = [];
  const q = await buy("quickstart: POST /api/hash (snippet as published)", "POST", "/api/hash", { text: "hello world" }, 0.001,
    (j) => typeof j?.hash === "string" || typeof j?.digest === "string" || Object.values(j || {}).some((v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v)));
  if (q?.ms) latencies.push(q.ms);

  // --- (e) buy a list of tools ---------------------------------------------
  const TOOLS = [
    ["pure-CPU uuid", "GET", "/api/uuid", { version: "7", count: "3" }, 0.001, (j) => JSON.stringify(j).match(/[0-9a-f]{8}-[0-9a-f]{4}-/i)],
    ["pure-CPU text-stats", "POST", "/api/text-stats", { text: "An agent pays for one request. The server answers with terms. The agent signs and retries." }, 0.001, (j) => j && Object.keys(j).length > 1],
    ["pure-CPU slugify", "POST", "/api/slugify", { text: "Hello, New Agent 2026" }, 0.001, (j) => /hello-new-agent-2026/.test(JSON.stringify(j))],
    ["pure-CPU base64", "POST", "/api/base64", { text: "hello", mode: "encode" }, 0.001, (j) => /aGVsbG8=/.test(JSON.stringify(j))],
    ["pure-CPU timezone-convert", "GET", "/api/timezone-convert", { datetime: "2026-06-23T14:00:00", from: "America/New_York", to: "Asia/Tokyo" }, 0.001, (j) => /2026-06-24|06\/24\/2026/.test(JSON.stringify(j))],
    ["pure-CPU json-validate", "POST", "/api/json-validate", { data: { name: "x" }, schema: { type: "object", required: ["name"] } }, 0.001, (j) => /true/.test(JSON.stringify(j))],
    ["data block-number", "GET", "/api/block-number", { network: "base" }, 0.001, (j) => /\d{6,}/.test(JSON.stringify(j))],
    ["data weather-forecast", "GET", "/api/weather-forecast", { lat: 40.71, lon: -74.01 }, 0.001, (j) => j && Object.keys(j).length > 1],
    ["data dns-lookup", "POST", "/api/dns-lookup", { host: "google.com", type: "MX" }, 0.002, (j) => /google/i.test(JSON.stringify(j))],
  ];
  for (const [name, m, p, body, price, check] of TOOLS) {
    const r = await buy(`buy: ${name}`, m, p, body, price, check);
    if (r?.ms) latencies.push(r.ms);
  }

  // One deliberately bad body: the refusal must say what was wrong, before
  // any payment round trip, and move no money.
  {
    const before = await balanceOf(fresh.address);
    const t = Date.now();
    let res, j = null;
    try {
      res = await mppFetch(`${TARGET}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "X-Heartbeat-Token": hb() }, body: JSON.stringify({ wrong: "field" }) });
      j = await res.json().catch(() => null);
    } catch (e) { record("bad body: self-explaining 400, not charged", false, Date.now() - t, `threw: ${e?.message || e}`); }
    if (res) {
      await sleep(3000);
      const after = await balanceOf(fresh.address);
      const selfExplaining = res.status === 400 && /text/.test(String(j?.error || "")) && Array.isArray(j?.required) && j?.example && typeof j.example === "object";
      record("bad body: self-explaining 400, not charged", selfExplaining && after === before, Date.now() - t, `status ${res.status}, error "${String(j?.error || "").slice(0, 60)}", balance ${after === before ? "unchanged" : `moved ${usd(before - after)}`}`);
    }
  }

  // --- (c, cont.) the MCP connector: tools/list + one paid call ------------
  {
    const t = Date.now();
    const client = new Client({ name: "mpp-new-agent-e2e", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${TARGET}/mcp`), { requestInit: { headers: { "X-Heartbeat-Token": hb() } } });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      const names = (list.tools || []).map((x) => x.name);
      record("mcp: tools/list", names.includes("catalog.call") && names.includes("catalog.search"), Date.now() - t, `${names.length} tools`);
      McpClient.wrap(client, { methods: [tempo.charge({ account: fresh })] });
      const t2 = Date.now();
      if (spent + 0.001 <= BUDGET_USD) {
        const r = await client.callTool({ name: "catalog.call", arguments: { slug: "block-number", params: { network: "base" } } });
        const ms = Date.now() - t2;
        const receipt = r?._meta?.["org.paymentauth/receipt"] || r?.receipt;
        const ok = !r?.isError && !!receipt && /\d{6,}/.test(JSON.stringify(r?.structuredContent || r?.content || ""));
        if (ok) spent += 0.001;
        latencies.push(ms);
        record("mcp: paid catalog.call block-number over tempo", ok && ms <= ROW_FAIL_MS, ms, ok ? `receipt ${String(receipt.reference || "").slice(0, 18)}...` : JSON.stringify(r?.content || "").slice(0, 100));
      }
    } catch (e) {
      record("mcp: tools/list + paid call", false, Date.now() - t, `threw: ${e?.message || e}`);
    } finally {
      try { await client.close(); } catch { /* closed */ }
    }
  }

  // --- latency target -------------------------------------------------------
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null;
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  console.log(`\nlatency over ${sorted.length} paid calls: p50 ${p50} ms, p95 ${p95} ms (target p95 < ${TARGET_P95_MS} ms)${p95 != null && p95 >= TARGET_P95_MS ? "  WARN: over target" : ""}`);
}

async function refundLeftover() {
  try {
    const bal = await balanceOf(fresh.address);
    // Leave a small reserve for the transfer's own fee (paid in USDC.e).
    const reserve = 5_000n;
    if (bal <= reserve) { console.log(`leftover ${usd(bal)} USDC.e - too small to return`); return; }
    const tx = await sendUsdcE(fresh, burner.address, bal - reserve);
    console.log(`returned ${usd(bal - reserve)} USDC.e to the burner (tx ${tx}); ${usd(await balanceOf(fresh.address))} left as fee dust`);
  } catch (e) {
    console.warn(`WARN  could not return the leftover to the burner: ${e?.message || e}`);
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; record("run", false, null, `crashed: ${e?.message || e}`); }
await refundLeftover();

console.log("\n| step | result | ms | note |");
console.log("|---|---|---:|---|");
for (const r of rows) console.log(`| ${r.step} | ${r.ok ? "PASS" : "FAIL"} | ${r.ms ?? ""} | ${r.note.replace(/\|/g, "/")} |`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed, spent $${spent.toFixed(3)} of $${BUDGET_USD}`);
process.exit(failed || crashed ? 1 : 0);
