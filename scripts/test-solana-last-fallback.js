#!/usr/bin/env node
// SOLANA_FALLBACK_FACILITATOR_URL: one more facilitator as the LAST Solana
// settle fallback (src/payments.js), off unless set.
//
// Unit half: the shared boot /supported check (confirmListedFallback) that
// Robinhood's listed fallbacks also use. Wire half: paid servers (ports from
// the OS) against stub facilitators. The first-tried facilitator (a stub on
// the PayAI slot, standing in for whichever settles Solana first) refuses a
// Solana settle before broadcasting; Solvador refuses the same way; the new
// one settles last, exactly once. It is never asked to verify, never asked
// before the earlier settlers, never handed a Base payment, never asked after
// a failure that may have broadcast; one whose /supported lacks Solana exact
// is dropped at boot, and with the variable unset nothing contacts it.
//   node scripts/test-solana-last-fallback.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { confirmListedFallback } from "../src/payments.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";

// ---- the boot check -------------------------------------------------------------
{
  const logs = [];
  const opts = (extra = {}) => ({ network: SOL, chain: "Solana", listName: "Solana's", recheckMs: 50, log: (m) => logs.push(m), warn: (m) => logs.push(m), ...extra });
  const yes = { name: "yes", client: { getSupported: async () => ({ kinds: [{ scheme: "exact", network: SOL }] }) }, confirmed: false };
  let confirmedCalls = 0, dropped = 0;
  await confirmListedFallback(yes, opts({ onConfirm: () => confirmedCalls++, onDrop: () => dropped++ }));
  ok(yes.confirmed === true && confirmedCalls === 1 && dropped === 0, "a /supported listing exact on the network confirms it");
  const other = { name: "other", client: { getSupported: async () => ({ kinds: [{ scheme: "exact", network: BASE }, { scheme: "upto", network: SOL }] }) }, confirmed: false };
  await confirmListedFallback(other, opts({ onConfirm: () => confirmedCalls++, onDrop: () => dropped++ }));
  ok(other.confirmed === false && dropped === 1 && confirmedCalls === 1, "exact on another network, or another scheme on this one, drops it");
  ok(logs.some((l) => l === `WARNING: other does not advertise exact on ${SOL} - dropped from Solana's settle fallback`), "the drop is a warning that names it");
  let answers = 0;
  const later = { name: "later", client: { getSupported: async () => { if (++answers < 3) throw new Error("ECONNREFUSED"); return { kinds: [{ scheme: "exact", network: SOL }] }; } }, confirmed: false };
  await confirmListedFallback(later, opts());
  ok(later.confirmed === false && logs.some((l) => /later unreachable \(ECONNREFUSED\); not tried until its \/supported answers/.test(l)), "an unreachable one is not confirmed, and says so once");
  for (let i = 0; i < 40 && !later.confirmed; i++) await sleep(25);
  ok(later.confirmed === true && answers === 3 && logs.some((l) => l === "Solana: later confirmed for the settle fallback"), `it is asked again in the background until it answers (${answers} reads)`);
}

// ---- the wire -------------------------------------------------------------------
const kit = await import("@solana/kit");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const feePayer = await kit.generateKeyPairSigner();
const payTo = await kit.generateKeyPairSigner();
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
async function solanaTx(amount) {
  const buyer = await kit.generateKeyPairSigner();
  const src = (await kit.generateKeyPairSigner()).address;
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
    (m) => kit.appendTransactionMessageInstructions([{ programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(MINT), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ], data: new Uint8Array([12, ...u64(amount), 6]) }], m),
  );
  return kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
}

const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const stub = (handler) => createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* ignore */ } handler(req.url.split("?")[0], res, body); });
});
const refusal402 = (res, network) => json(res, 402, { success: false, errorReason: "unexpected_settle_error", errorMessage: "settle refused", transaction: "", network });

// One world per boot: its own stubs and its own call order.
async function world({ lastListsSolana = true, lastEnv = true, fallback = true } = {}) {
  const [PORT, PAYAI, SOLV, LAST] = await getFreePorts(4);
  const st = { order: [], primaryMode: "refuse", lastSupported: 0, lastVerify: 0, lastSettle: 0, lastSettleNetworks: [], seq: 0 };
  const servers = [
    [stub((path, res, body) => {
      if (path === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
      if (path === "/verify") return json(res, 200, { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from || payTo.address });
      if (path === "/settle") {
        const net = body?.paymentRequirements?.network;
        st.order.push(`payai:${net}`);
        if (st.primaryMode === "5xx") return json(res, 502, { success: false, errorReason: "unexpected_error", errorMessage: "upstream", transaction: "", network: net });
        return refusal402(res, net);
      }
      if (path === "/rpc") return json(res, 200, { jsonrpc: "2.0", id: 1, result: "0x0" });
      return json(res, 404, {});
    }), PAYAI],
    [stub((path, res, body) => {
      if (path === "/supported") return json(res, 200, { kinds: [], extensions: [], signers: {} });
      if (path === "/settle") { const net = body?.paymentRequirements?.network; st.order.push(`solvador:${net}`); return refusal402(res, net); }
      return json(res, 404, {});
    }), SOLV],
    [stub((path, res, body) => {
      if (path === "/supported") { st.lastSupported++; return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: lastListsSolana ? SOL : BASE, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} }); }
      if (path === "/verify") { st.lastVerify++; return json(res, 200, { isValid: true }); }
      if (path === "/settle") {
        const net = body?.paymentRequirements?.network;
        st.lastSettle++; st.lastSettleNetworks.push(net); st.order.push(`last:${net}`);
        return json(res, 200, { success: true, transaction: String(++st.seq).padStart(4, "0") + "6".repeat(84), network: net, payer: payTo.address });
      }
      return json(res, 404, {});
    }), LAST],
  ];
  await Promise.all(servers.map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const env = { ...process.env };
  delete env.STATE_DATABASE_URL; delete env.REDIS_URL; delete env.SOLANA_FALLBACK_FACILITATOR_URL;
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, ...ownStoreEnv("sol-last"), PORT: String(PORT), FREE_MODE: "", NODE_ENV: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
      FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYAI_FACILITATOR_URL: `http://127.0.0.1:${PAYAI}`,
      SOLVADOR_KEY: "solvador-test-key", SOLVADOR_FACILITATOR_URL: `http://127.0.0.1:${SOLV}`,
      AGENT402_BASE_RPC: `http://127.0.0.1:${PAYAI}/rpc`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      PAYMENT_SETTLE_FALLBACK: fallback ? "true" : "", FACILITATOR_GAS_CHECK: "off",
      ...(lastEnv ? { SOLANA_FALLBACK_FACILITATOR_URL: `http://127.0.0.1:${LAST}` } : {}),
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) log.push(l.slice(0, 400)); if (log.length > 300) log.splice(0, log.length - 300); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const B = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
  const PATH = "/api/hash";
  const BODY = JSON.stringify({ text: "x", algo: "sha256" });
  let offer = null;
  if (up) {
    const bare = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
    offer = JSON.parse(Buffer.from(String(bare.headers.get("payment-required")), "base64").toString("utf8"));
  }
  let n = 0;
  const pay = async (network) => {
    const accepted = (offer?.accepts || []).find((a) => a.network === network && a.scheme === "exact");
    if (!accepted) return { status: 0, why: `no ${network} accept` };
    const payload = network === SOL
      ? { transaction: await solanaTx(Number(accepted.amount)) }
      : { signature: "0x" + "11".repeat(65), authorization: { from: `0x${(0xa00 + ++n).toString(16).padStart(40, "0")}`, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7700 + n).toString(16).padStart(64, "0") } };
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted, payload })).toString("base64");
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: BODY });
    await r.text();
    const hdr = r.headers.get("payment-response");
    return { status: r.status, receipt: hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null };
  };
  const stop = () => { proc.kill("SIGKILL"); for (const [s] of servers) s.close(); };
  return { st, log, up, offer, pay, stop, LAST };
}

const worlds = [];
try {
  const [on, dropped, unset, off] = await Promise.all([world(), world({ lastListsSolana: false }), world({ lastEnv: false }), world({ fallback: false })]);
  worlds.push(on, dropped, unset, off);

  // ---- set, and its /supported lists Solana exact ----
  ok(on.up && (on.offer?.accepts || []).some((a) => a.network === SOL) && (on.offer?.accepts || []).some((a) => a.network === BASE), "set: the server boots and offers Solana and Base as before");
  for (let i = 0; i < 40 && !on.log.some((l) => /Solana last fallback .* is the last settle fallback/.test(l)); i++) await sleep(100);
  ok(on.log.some((l) => l.includes(`Solana last fallback (http://127.0.0.1:${on.LAST}) is the last settle fallback`)), "set: the boot line names it as the last Solana settle fallback");
  ok(on.st.lastSupported >= 1, "set: its /supported was read at boot");
  {
    const r = await on.pay(SOL);
    ok(r.status === 200 && r.receipt?.success === true && /^0001/.test(String(r.receipt?.transaction || "")), `set: Solana refused by every earlier settler is settled by it -> 200 with its tx (${r.status} ${r.receipt?.transaction})`);
    ok(JSON.stringify(on.st.order) === JSON.stringify([`payai:${SOL}`, `solvador:${SOL}`, `payai:${SOL}`, `last:${SOL}`]), `set: it is tried last, after the first-tried settler and the existing fallbacks (${on.st.order.join(" -> ")})`);
    ok(on.st.lastSettle === 1 && on.st.lastVerify === 0, "set: one settle there, and it never verifies (never primary)");
  }
  {
    on.st.order.length = 0;
    const r = await on.pay(BASE);
    ok(r.status === 402, `set: a refused Base payment stays refused (${r.status})`);
    ok(on.st.order.length > 0 && on.st.order.every((x) => !x.startsWith("last:")) && on.st.lastSettleNetworks.every((x) => x === SOL), `set: another network never reaches it (${on.st.order.join(" -> ")})`);
  }
  {
    on.st.order.length = 0; on.st.primaryMode = "5xx";
    const before = on.st.lastSettle;
    const r = await on.pay(SOL);
    ok(r.status === 402 && on.st.lastSettle === before && JSON.stringify(on.st.order) === JSON.stringify([`payai:${SOL}`]), `set: a failure that may have broadcast never reaches it (${r.status}; ${on.st.order.join(" -> ")})`);
  }

  // ---- set, but its /supported lacks Solana exact: dropped at boot ----
  for (let i = 0; i < 40 && !dropped.log.some((l) => /dropped from Solana's settle fallback/.test(l)); i++) await sleep(100);
  ok(dropped.log.some((l) => l.includes(`Solana last fallback (http://127.0.0.1:${dropped.LAST}) does not advertise exact on ${SOL} - dropped from Solana's settle fallback`)), "dropped: a stub without Solana exact is dropped at boot, by name");
  {
    const r = await dropped.pay(SOL);
    ok(r.status === 402 && dropped.st.lastSettle === 0 && JSON.stringify(dropped.st.order) === JSON.stringify([`payai:${SOL}`, `solvador:${SOL}`, `payai:${SOL}`]), `dropped: the chain ends where it always did (${r.status}; ${dropped.st.order.join(" -> ")})`);
  }

  // ---- unset: nothing changes ----
  {
    const r = await unset.pay(SOL);
    ok(r.status === 402 && JSON.stringify(unset.st.order) === JSON.stringify([`payai:${SOL}`, `solvador:${SOL}`, `payai:${SOL}`]), `unset: the Solana chain is exactly the old one (${r.status}; ${unset.st.order.join(" -> ")})`);
    ok(unset.st.lastSupported === 0 && unset.st.lastSettle === 0 && unset.st.lastVerify === 0 && !unset.log.some((l) => /Solana last fallback/.test(l)), "unset: nothing contacts it and nothing names it");
  }

  // ---- set while PAYMENT_SETTLE_FALLBACK is off: inert ----
  {
    const r = await off.pay(SOL);
    ok(r.status === 402 && JSON.stringify(off.st.order) === JSON.stringify([`payai:${SOL}`]) && off.st.lastSupported === 0, `fallback off: nothing past the first settler, and it is never contacted (${off.st.order.join(" -> ")})`);
    ok(off.log.some((l) => l.includes("SOLANA_FALLBACK_FACILITATOR_URL has no effect while PAYMENT_SETTLE_FALLBACK is off")), "fallback off: the boot warns that it has no effect");
  }
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || e);
} finally {
  for (const w of worlds) w.stop();
}
if (failed) for (const [label, w] of [["on", worlds[0]], ["dropped", worlds[1]], ["unset", worlds[2]], ["off", worlds[3]]]) { if (!w) continue; console.error(`--- ${label} server output (last lines) ---`); for (const l of w.log.slice(-25)) console.error(l); }
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
