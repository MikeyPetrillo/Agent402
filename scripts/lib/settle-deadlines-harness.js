// The stub facilitators (Base's, Celo's, the settle fallback), the stub
// chain both networks' RPC read, and a paid-mode boot of the real server
// against them, for the settle-deadline suites (scripts/test-settle-deadlines.js,
// scripts/test-settle-deadlines-pg.js).
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { bootServer } from "./boot-server.js";

export const BASE = "eip155:8453";
export const CELO = "eip155:42220";
export const CELO_ROW = { capMs: 2500, checkAfterMs: 500, checkEveryMs: 250, slowMs: 1200 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the stubs and boot the server; `env` is merged over the suite's. */
export async function startSettleDeadlineHarness({ env = {}, stores = "settle-deadlines" } = {}) {
  const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
  const topic = (a) => `0x${String(a).slice(2).toLowerCase().padStart(64, "0")}`;
  const landTxOf = (nonce) => `0x${createHash("sha256").update(`land:${String(nonce).toLowerCase()}`).digest("hex")}`;

  // ---- the stub chain: one per test, read by both networks' RPC ------------------
  const chain = { used: new Map(), reads: { [BASE]: 0, [CELO]: 0 } };
  const receiptFor = ({ tx, asset, payer, payTo, amount, nonce }) => ({ status: "0x1", blockNumber: "0x3e0", transactionHash: tx, logs: [
    { address: asset, topics: [AUTH_USED, topic(payer), String(nonce).toLowerCase()], data: "0x" },
    { address: asset, topics: [TRANSFER, topic(payer), topic(payTo)], data: word(amount) },
  ] });
  const land = (p) => { const tx = landTxOf(p.nonce); chain.used.set(String(p.nonce).toLowerCase(), { tx, receipt: receiptFor({ ...p, tx }) }); return tx; };

  // ---- stub facilitators ---------------------------------------------------------
  const st = { base: "ok", celo: "ok", fallback: "ok", holdMs: 0 };
  const counts = { base: 0, celo: 0, fallback: 0, verify: 0 };
  const releases = new Set();
  let txN = 0;
  const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const stub = (name) => createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
      if (req.url === "/supported") {
        const kinds = name === "base" ? [{ x402Version: 2, scheme: "exact", network: BASE }] : name === "celo" ? [{ x402Version: 2, scheme: "exact", network: CELO }] : [];
        return json(res, 200, { kinds, extensions: [], signers: {} });
      }
      if (req.url.startsWith("/rpc/")) {
        const net = req.url.slice(5) === "8453" ? BASE : CELO;
        const out = (result) => json(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, result });
        const p0 = parsed.params?.[0];
        if (parsed.method === "eth_getLogs") chain.reads[net]++;
        if (parsed.method === "eth_call") {
          const data = String(p0?.data || "");
          if (data.startsWith("0xe94a0102")) return out(word(chain.used.has(`0x${data.slice(-64)}`.toLowerCase()) ? 1 : 0));
          if (data.startsWith("0x313ce567")) return out(word(6));
          return out("0x0");
        }
        if (parsed.method === "eth_getTransactionReceipt") return out([...chain.used.values()].find((u) => u.tx === String(p0).toLowerCase())?.receipt ?? null);
        if (parsed.method === "eth_blockNumber") return out("0x3e8");
        if (parsed.method === "eth_getBlockByNumber") return out({ number: "0x3e8", timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
        if (parsed.method === "eth_getLogs") { const u = chain.used.get(String(p0?.topics?.[2] || "").toLowerCase()); return out(u ? [{ address: p0?.address, transactionHash: u.tx, blockNumber: "0x3e0" }] : []); }
        return out("0x0");
      }
      const payer = parsed.paymentPayload?.payload?.authorization?.from;
      const nonce = String(parsed.paymentPayload?.payload?.authorization?.nonce || "").toLowerCase();
      const network = parsed.paymentRequirements?.network;
      if (req.url === "/verify") { counts.verify++; return json(res, 200, { isValid: true, payer }); }
      if (req.url !== "/settle") return json(res, 404, {});
      counts[name]++;
      const mode = st[name];
      const answer = () => json(res, 200, { success: true, transaction: chain.used.get(nonce)?.tx || `0x${(++txN).toString(16).padStart(64, "0")}`, network, payer });
      const r = parsed.paymentRequirements || {};
      const p = { asset: r.asset, payTo: r.payTo, amount: r.amount, payer, nonce };
      // Held for up to 30 s (released at the end of the suite), answering
      // success; "land-hold" puts the transfer on chain at once.
      if (mode === "hold30" || mode === "land-hold") {
        if (mode === "land-hold") land(p);
        const end = Date.now() + 30_000;
        const rel = () => { releases.delete(rel); answer(); };
        releases.add(rel);
        const t = setInterval(() => { if (!releases.has(rel)) return clearInterval(t); if (Date.now() > end) { clearInterval(t); rel(); } }, 200);
        return;
      }
      if (mode === "slow") return setTimeout(answer, st.holdMs);
      return answer();
    });
  });
  const servers = { base: stub("base"), celo: stub("celo"), fallback: stub("fallback") };
  await Promise.all(Object.values(servers).map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
  const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
  const TMP = mkdtempSync(join(tmpdir(), "settle-deadlines-"));
  const LATE = join(TMP, "late.json");

  const srv = await bootServer({
      stores,
      args: ["--import", "./scripts/lib/loopback-only-preload.js"],
      env: {
        FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,celo",
        FACILITATOR_URL: urlOf(servers.base), PAYAI_FACILITATOR_URL: urlOf(servers.base), CELO_FACILITATOR_URL: urlOf(servers.celo), CELO_FACILITATOR_KEY: "celo-test-key",
        EVM_RPC_8453: `${urlOf(servers.base)}/rpc/8453`, AGENT402_BASE_RPC: `${urlOf(servers.base)}/rpc/8453`, EVM_RPC_42220: `${urlOf(servers.base)}/rpc/42220`,
        FACILITATOR_GAS_CHECK: "off", SOLVADOR_KEY: "settle-deadlines-key", SOLVADOR_FACILITATOR_URL: urlOf(servers.fallback), SOLVADOR_CELO_PRIMARY: "",
        PAYMENT_SETTLE_FALLBACK: "true", LATE_SETTLE_FILE: LATE, LATE_SETTLE_RECONCILE: "", X402_SYNC_ON_START: "", LATE_SETTLE_RECONCILE_MS: "500",
        SETTLE_DEADLINES: JSON.stringify({ celo: CELO_ROW }), SETTLE_SLOW_AFTER: "2", SETTLE_SLOW_COOLDOWN_MS: "3000",
        GATEWAY_SETTLE_BREAKER_MAX: "100",
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", CIRCLE_FACILITATOR_API_KEY: "",
        MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "", OPENROUTER_API_KEY: "",
        REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", NETWORK_PRICE_PREMIUMS: "", NETWORK_PRICE_FLOORS: "",
        STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
        MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
        SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
        ...env,
      },
    }).catch(async (e) => { for (const s of Object.values(servers)) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } rmSync(TMP, { recursive: true, force: true }); throw e; });
  const B = srv.url;
  const PATH = "/api/hash";
  const body = JSON.stringify({ text: "hello world" });
  const send = async (header, callBody = body) => {
    const t0 = Date.now();
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: callBody });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    const hdr = r.headers.get("payment-response");
    let receipt = null; try { receipt = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null; } catch { /* unreadable */ }
    return { status: r.status, text, body: j, receipt, ms: Date.now() - t0, replayed: r.headers.get("x-replayed-answer") };
  };
  const pay = async (network) => {
    const account = privateKeyToAccount(generatePrivateKey());
    const payments = new x402Client();
    registerExactEvmScheme(payments, { signer: account });
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    await r.arrayBuffer();
    const offer = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
    const accepted = (offer.accepts || []).find((a) => a.network === network);
    if (!accepted) throw new Error(`no ${network} offer: ${JSON.stringify(offer.accepts?.map((a) => a.network))}`);
    const payload = await payments.createPaymentPayload({ ...offer, accepts: [accepted] });
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    const out = await send(header);
    const a = payload.payload.authorization;
    return { ...out, header, payer: a.from, nonce: a.nonce, asset: accepted.asset, payTo: accepted.payTo, amount: accepted.amount };
  };
  const snap = () => ({ ...counts, reads: { ...chain.reads } });
  const asked = (c0) => `${counts.celo - c0.celo}/${counts.fallback - c0.fallback}`;
  const lateEntries = () => { try { return Object.values(JSON.parse(readFileSync(LATE, "utf8")).pending || {}); } catch { return []; } };
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
  const refundOf = async (tx) => { try { return await (await fetch(`${B}/api/refunds?tx=${tx}`)).json(); } catch { return null; } };
  const owedLines = (tx) => srv.log().split("\n").filter((l) => l.includes(`tx ${tx} landed after a 402; booked owed`)).length;

  const stop = async () => {
    for (const rel of [...releases]) rel();
    await srv.stop();
    for (const s of Object.values(servers)) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    rmSync(TMP, { recursive: true, force: true });
  };
  return { srv, B, send, pay, snap, asked, lateEntries, waitFor, refundOf, owedLines, chain, st, counts, releases, land, landTxOf, stop, sleep };
}
