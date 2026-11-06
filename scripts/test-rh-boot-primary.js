#!/usr/bin/env node
// Robinhood boot order and refusals in words, end to end (paid-mode boots vs
// stub facilitators, offline).
//  1. The first listed facilitator's /supported is down at boot, the second's
//     is up: USDG on eip155:4663 is still offered, the boot names the second,
//     and a paid call settles through it (the first is never asked to settle).
//  2. Both up: the first settles, as before. When it answers HTTP 200
//     {success:false} in words with no verdict, the second settles the same
//     payment; when its words are a verdict about the buyer (a bad signature),
//     the buyer gets 402 and the second is never asked.
//   node scripts/test-rh-boot-primary.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { getFreePorts } = await import(root + "/scripts/lib/free-port.js");
const { createServer } = await import("node:http");
const { spawn } = await import("node:child_process");
const { mkdtempSync, rmSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");

const RH = "eip155:4663";
const SIGNATURE = 'Signature does not authorize this transfer for 0x0000000000000000000000000000000000000e01 (EIP-712 domain "Global Dollar" v1 on chain 4663)';
const NO_VERDICT = "Relay temporarily unavailable, try again";
const json = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const stub = (h) => createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch {} h(req, res, body); }); });
const kinds = { kinds: [{ x402Version: 2, scheme: "exact", network: RH }], extensions: [], signers: {} };
const payerOf = (b) => b?.paymentPayload?.payload?.authorization?.from;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`ok - ${msg}`); else { failed++; console.log(`FAIL - ${msg}`); } };

/** A facilitator stub: /supported up or 503, /verify valid, /settle by mode. */
function facilitator(name, st) {
  st[name] = { up: true, mode: "ok", settles: 0 };
  return stub((q, r, b) => {
    const s = st[name];
    if (q.url === "/supported") return s.up ? json(r, 200, kinds) : json(r, 503, { error: "down" });
    if (q.url === "/verify") return json(r, 200, { isValid: true, payer: payerOf(b) });
    if (q.url === "/settle") {
      s.settles++;
      if (s.mode === "prose") return json(r, 200, { success: false, transaction: "", payer: "", network: RH, errorReason: NO_VERDICT });
      if (s.mode === "signature") return json(r, 200, { success: false, transaction: "", payer: "", network: RH, errorReason: SIGNATURE });
      return json(r, 200, { success: true, transaction: "0x" + (name === "rh1" ? "1a" : "2b").repeat(32), network: RH, payer: payerOf(b) });
    }
    return json(r, 404, {});
  });
}

async function boot(setup, { firstHost = "127.0.0.1", extraEnv = {} } = {}) {
  const [PORT, BASE_FAC, RH1, RH2] = await getFreePorts(4);
  const st = {};
  const servers = [
    [stub((q, r) => q.url === "/supported" ? json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }) : q.url === "/rpc" ? json(r, 200, { jsonrpc: "2.0", id: 1, result: "0x0" }) : json(r, 404, {})), BASE_FAC],
    [facilitator("rh1", st), RH1],
    [facilitator("rh2", st), RH2],
  ];
  setup(st);
  await Promise.all(servers.map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const tmp = mkdtempSync(join(tmpdir(), "a402-rh-boot-"));
  const env = { ...process.env }; delete env.STATE_DATABASE_URL; delete env.REDIS_URL; delete env.SOLVADOR_KEY; delete env.ROBINHOOD_RELAYER_KEY;
  const proc = spawn(process.execPath, ["src/server.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "", PAYMENT_NETWORKS: "base,robinhood",
    ROBINHOOD_FACILITATOR_URL: `http://${firstHost}:${RH1},http://127.0.0.1:${RH2}`, ROBINHOOD_FALLBACK_RECHECK_MS: "60000", ...extraEnv,
    PAYMENT_SETTLE_FALLBACK: "true", SALES_LEDGER_DB: join(tmp, "sales.db"), REFUND_DB_DIR: tmp, FACILITATOR_GAS_CHECK: "off",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
  const log = []; proc.stdout.on("data", (c) => log.push(String(c))); proc.stderr.on("data", (c) => log.push(String(c)));
  const B = `http://127.0.0.1:${PORT}`;
  let up = false; for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
  const PATH = "/api/demand-radar?limit=1";
  let accepted = null;
  if (up) {
    const r402 = await fetch(`${B}${PATH}`);
    const h = r402.headers.get("payment-required");
    accepted = h ? JSON.parse(Buffer.from(h, "base64").toString()).accepts.find((a) => a.network === RH) || null : null;
  }
  let n = 0;
  const pay = async () => {
    const cred = Buffer.from(JSON.stringify({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from: `0x${(0xe00 + ++n).toString(16).padStart(40, "0")}`, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7700 + n + Math.floor(Math.random() * 1e6)).toString(16).padStart(64, "0") } } })).toString("base64");
    const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred } }); await r.text();
    return r.status;
  };
  const stop = () => { proc.kill("SIGKILL"); for (const [s] of servers) s.close(); rmSync(tmp, { recursive: true, force: true }); };
  const get = async (path) => { const r = await fetch(`${B}${path}`); return r.text(); };
  return { up, accepted, pay, st, log, stop, RH2, get };
}

// 1. The first listed facilitator is down at boot.
{
  // The first is named by another host, so the public-index disclosure shows which one it names.
  const b = await boot((st) => { st.rh1.up = false; }, { firstHost: "localhost", extraEnv: { FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood" } });
  try {
    check(b.up, "boot 1: the paid-mode server booted with the first listed facilitator down");
    check(!!b.accepted, "boot 1: USDG on eip155:4663 is still offered (the second listed confirmed it)");
    check(b.log.join("").includes(`127.0.0.1:${b.RH2} settles first`), "boot 1: the boot log names the facilitator that settles first");
    if (b.up) {
      const privacy = await b.get("/privacy");
      const para = (privacy.match(/<li id="public-settlement-index">([\s\S]*?)<\/li>/) || [])[1] || "";
      check(para.includes("(127.0.0.1)") && !para.includes("localhost"), `boot 1: /privacy names the facilitator the boot chose, not the first listed (${para.slice(0, 120)})`);
      const hosts = JSON.parse(await b.get("/.well-known/x402"))?.payment?.dataHandling?.publicSettlementIndex?.hosts;
      check(JSON.stringify(hosts) === JSON.stringify(["127.0.0.1"]), `boot 1: /.well-known/x402 names the chosen facilitator (${JSON.stringify(hosts)})`);
    }
    const status = b.accepted ? await b.pay() : 0;
    check(status === 200 && b.st.rh2.settles === 1 && b.st.rh1.settles === 0, `boot 1: a paid call settles through the second, once; the first is never asked (status ${status}, rh1 ${b.st.rh1.settles}, rh2 ${b.st.rh2.settles})`);
  } finally { if (failed) console.log(b.log.join("").slice(-2500)); b.stop(); }
}

// 2. Both up.
{
  const before = failed;
  const b = await boot(() => {});
  try {
    check(b.up && !!b.accepted, "boot 2: both up, USDG on eip155:4663 offered");
    check(!b.log.join("").includes("settles first, the rest stay"), "boot 2: the list order stands, no reorder logged");
    let status = b.accepted ? await b.pay() : 0;
    check(status === 200 && b.st.rh1.settles === 1 && b.st.rh2.settles === 0, `boot 2: the first settles, as before (status ${status}, rh1 ${b.st.rh1.settles}, rh2 ${b.st.rh2.settles})`);
    b.st.rh1.mode = "prose";
    status = b.accepted ? await b.pay() : 0;
    check(status === 200 && b.st.rh1.settles === 2 && b.st.rh2.settles === 1, `boot 2: the first answers 200 success:false in words, no verdict -> the second settles it (status ${status}, rh1 ${b.st.rh1.settles}, rh2 ${b.st.rh2.settles})`);
    b.st.rh1.mode = "signature";
    status = b.accepted ? await b.pay() : 0;
    check(status === 402 && b.st.rh1.settles === 3 && b.st.rh2.settles === 1, `boot 2: a signature verdict in words -> 402, the second never asked (status ${status}, rh1 ${b.st.rh1.settles}, rh2 ${b.st.rh2.settles})`);
  } finally { if (failed > before) console.log(b.log.join("").slice(-2500)); b.stop(); }
}
console.log(`test-rh-boot-primary: ${failed ? `FAILED (${failed})` : "all passed"}`);
process.exit(failed ? 1 : 0);
