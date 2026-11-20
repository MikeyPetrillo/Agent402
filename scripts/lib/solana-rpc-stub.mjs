// Stub Solana JSON-RPC lanes that count calls, for the offline suites and the
// local replay of the activity scans and the Solana board (no network).
//
// A WORLD is a set of wallets, each with a USDC token account and a list of
// payments (newest first). A LANE is an HTTP server on port 0 answering
// getTokenAccountsByOwner, getSignaturesForAddress (limit, before, until) and
// getTransaction from the world, and counting each method. `mode` applies to
// getTransaction: ok | http429 | error | hang.
import { createServer } from "node:http";

export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A deterministic base58 address of 44 characters from a small integer. */
export function addr(n, tag = "W") {
  let x = (n + 1) * 2654435761 >>> 0, out = tag;
  while (out.length < 44) { x = (x * 1103515245 + 12345) >>> 0; out += B58[x % B58.length]; }
  return out;
}

export function makeWorld({ nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const world = { nowSec, wallets: new Map(), txs: new Map(), seq: 0 };
  /** Add `count` payments to a wallet, the newest `ageSec` old and one every `gapSec` before it. */
  world.addPayments = (wallet, count, { ageSec = 60, gapSec = 600, buyers = 5 } = {}) => {
    let w = world.wallets.get(wallet);
    if (!w) { w = { ata: `ATA${wallet.slice(3)}`, sigs: [] }; world.wallets.set(wallet, w); }
    const fresh = [];
    for (let i = 0; i < count; i++) {
      const n = ++world.seq;
      const signature = `sig${String(n).padStart(8, "0")}x${wallet.slice(1, 9)}`;
      const blockTime = world.nowSec - ageSec - i * gapSec;
      const payer = addr(n % buyers, "B");
      const amount = 1000 + (n % 50) * 100;
      world.txs.set(signature, { wallet, blockTime, payer, amount });
      fresh.push({ signature, blockTime, err: null, slot: 300_000_000 + n });
    }
    // Chain order, newest first: a payment added later is newer than every
    // one the wallet already holds, whatever block time it was given.
    w.sigs = [...fresh, ...w.sigs];
    return fresh.map((s) => s.signature);
  };
  world.byAta = (ata) => [...world.wallets.values()].find((w) => w.ata === ata) || null;
  world.txFor = (signature) => {
    const t = world.txs.get(signature);
    if (!t) return null;
    const row = (accountIndex, owner, amount) => ({ accountIndex, mint: USDC, owner, uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6, uiAmountString: String(amount / 1e6) } });
    return { blockTime: t.blockTime, slot: 1, transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } },
      meta: { err: null, fee: 5000, logMessages: [], preTokenBalances: [row(0, t.wallet, 1000), row(1, t.payer, 9_000_000)], postTokenBalances: [row(0, t.wallet, 1000 + t.amount), row(1, t.payer, 9_000_000 - t.amount)] } };
  };
  return world;
}

export async function startLane(world, name) {
  const lane = { name, mode: "ok", calls: { getTransaction: 0, getSignaturesForAddress: 0, getTokenAccountsByOwner: 0, other: 0 }, failFor: new Set(), url: "", server: null };
  lane.reset = () => { for (const k of Object.keys(lane.calls)) lane.calls[k] = 0; };
  lane.total = () => Object.values(lane.calls).reduce((a, b) => a + b, 0);
  lane.server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
      let method, params;
      try { ({ method, params } = JSON.parse(body)); } catch { res.statusCode = 400; return res.end(); }
      const send = (o, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (method in lane.calls) lane.calls[method]++; else lane.calls.other++;
      if (method === "getTransaction") {
        if (lane.mode === "hang") return;
        if (lane.mode === "http429") { res.statusCode = 429; res.setHeader("retry-after", "1"); return res.end("Too Many Requests"); }
        if (lane.mode === "error" || lane.failFor.has(params[0])) return send({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "internal" } }, 500);
        return send({ jsonrpc: "2.0", id: 1, result: world.txFor(params[0]) });
      }
      if (method === "getTokenAccountsByOwner") {
        const w = world.wallets.get(params[0]);
        return send({ jsonrpc: "2.0", id: 1, result: { value: w ? [{ pubkey: w.ata, account: {} }] : [] } });
      }
      if (method === "getSignaturesForAddress") {
        const w = world.byAta(params[0]);
        let list = w ? w.sigs : [];
        const { limit = 1000, before, until } = params[1] || {};
        if (before) { const i = list.findIndex((s) => s.signature === before); list = i >= 0 ? list.slice(i + 1) : []; }
        if (until) { const i = list.findIndex((s) => s.signature === until); if (i >= 0) list = list.slice(0, i); }
        return send({ jsonrpc: "2.0", id: 1, result: list.slice(0, limit) });
      }
      send({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown" } });
    });
  });
  await new Promise((r) => lane.server.listen(0, "127.0.0.1", r));
  lane.url = `http://127.0.0.1:${lane.server.address().port}`;
  lane.close = () => new Promise((r) => { lane.server.closeAllConnections?.(); lane.server.close(() => r()); });
  return lane;
}

/** A direct JSON-RPC caller for one lane (the signature and account reads). */
export const direct = (lane) => async (method, params) => {
  const r = await fetch(lane.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error("rpc error " + j.error.message);
  return j.result;
};
