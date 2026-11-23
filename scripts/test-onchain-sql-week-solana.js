#!/usr/bin/env node
// onchain-sql-week paid on Solana, with the facilitator wired as production
// wires it (the keyed CDP client at its production URL;
// scripts/lib/cdp-origin-preload.js sends that origin, the facilitator and the
// query service, to a stand-in in THIS process). The stand-in's query
// service answers a whole-range query on solana.instructions with its 408
// (timed out) after WHOLE_MS and each day of the walk with two rows after the
// day's latency, so the handler's day walk is read end to end. Asserted:
//   - the route's 402 offers Solana exact (and the long-range route's does not);
//   - a 7-day walk paid on Solana answers inside the Solana budget
//     (SQL_WEEK_BUDGET_MS), every day merged in order, one whole-range query
//     and one a day, settled exactly once;
//   - days slow enough that the week cannot fit end the walk on time: the
//     answer is still inside the budget, partial in fields (complete false,
//     windowed.stoppedBy "time", coveredFrom/coveredTo), settled once;
//   - a walk with no rows in the days it could read is the uncharged 422:
//     nothing settled;
//   - an aggregate is answered as onchain-sql answers it.
//
//   node scripts/test-onchain-sql-week-solana.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

const kit = await import("@solana/kit");
const { SQL_WEEK_BUDGET_MS, SQL_WEEK_MAX_DAYS } = await import("../src/tools/cdp-kit.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DAY = 86_400_000;
// The stand-in's times, ms: a whole range that runs past the window, and a day.
const WHOLE_MS = 1_000;
let dayMs = 300;
let dayRows = 2;

const feePayer = await kit.generateKeyPairSigner();
const payTo = await kit.generateKeyPairSigner();
const buyer = await kit.generateKeyPairSigner();
const b58 = kit.getBase58Decoder();

const payments = new Map(); // wire transaction -> payer
let settles = 0, walkQueries = 0;
const cdp = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const reply = (status, obj) => { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { /* empty */ }
    const [path] = req.url.split("?");
    if (path === "/platform/v2/x402/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    if (path === "/platform/v2/x402/verify") return reply(200, { isValid: true, payer: payments.get(j?.paymentPayload?.payload?.transaction) });
    if (path === "/platform/v2/x402/settle") { settles++; await sleep(200); return reply(200, { success: true, transaction: b58.decode(randomBytes(64)), network: SOL, payer: payments.get(j?.paymentPayload?.payload?.transaction) }); }
    if (path === "/platform/v2/data/query/run") {
      const sql = String(j?.sql || "");
      if (!/wk_walk/.test(sql)) return reply(200, { result: [{ n: 1 }] }); // the server's own reads and the health probe
      walkQueries++;
      const ge = /block_time >= toDateTime\('([^']+)', 'UTC'\)/.exec(sql);
      const lt = /block_time < toDateTime\('([^']+)', 'UTC'\)/.exec(sql);
      if (!ge && !lt) { await sleep(WHOLE_MS); return reply(408, { errorType: "timed_out", errorMessage: "query timed out" }); }
      await sleep(dayMs);
      const from = ge ? Date.parse(ge[1].replace(" ", "T") + "Z") : Date.parse(lt[1].replace(" ", "T") + "Z") - DAY;
      const rows = Array.from({ length: dayRows }, (_, i) => ({ block_slot: Math.floor(from / 400) + i, block_time: new Date(from + (i + 1) * DAY / (dayRows + 1)).toISOString() }));
      return reply(200, { result: rows });
    }
    return reply(404, { errorMessage: "not stubbed" });
  });
});
await new Promise((r) => cdp.listen(0, "127.0.0.1", r));
const side = createServer((req, res) => {
  req.resume(); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const [path] = req.url.split("?");
    if (path === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    if (path === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(500, { error: "not asked in this suite" });
  });
});
await new Promise((r) => side.listen(0, "127.0.0.1", r));
const SIDE = `http://127.0.0.1:${side.address().port}`;

// An exact-scheme Solana payment (as scripts/test-onchain-sql-paid-path.js builds one).
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CB = "ComputeBudget111111111111111111111111111111";
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
let priceSeq = 1;
async function paymentTx(signer, amount) {
  const src = (await kit.generateKeyPairSigner()).address;
  const ixs = [
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, ...u32(20000)]) },
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(priceSeq++)]) },
    { programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(MINT), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: signer.address, role: kit.AccountRole.READONLY_SIGNER, signer },
    ], data: new Uint8Array([12, ...u64(amount), 6]) },
  ];
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
    (m) => kit.appendTransactionMessageInstructions(ixs, m),
  );
  return kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
let srv = null;
try {
  srv = await bootServer({
    args: ["--import", "./scripts/lib/cdp-origin-preload.js"], stores: "sql-week-solana",
    env: {
      FREE_MODE: "", NODE_ENV: "",
      CDP_ORIGIN_STUB: "1", CDP_ORIGIN_STUB_PORT: String(cdp.address().port),
      CDP_API_KEY_ID: "organizations/test/apiKeys/test", CDP_API_KEY_SECRET: privateKey.export({ type: "pkcs8", format: "pem" }),
      CDP_SQL_API_KEY_ID: "", CDP_SQL_API_KEY_SECRET: "",
      CDP_FACILITATOR_URL: "", FACILITATOR_URL: "", SOLANA_FACILITATOR_URL: "", SOLANA_FACILITATOR_SHARE: "",
      PAYAI_FACILITATOR_URL: SIDE, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
      AGENT402_BASE_RPC: `${SIDE}/rpc`, MPP_SECRET_KEY: "", TEMPO_API_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", FIRST_CALL_ALLOWANCE: "",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "", UPSTREAM_HANDLER_BUDGET_MS: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
      ONCHAIN_SQL_INFLIGHT_MAX: "", CDP_SQL_SEND_GAP_MS: "", RATE_LIMIT_REPLICAS: "1",
      STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", RECEIPT_SIGNING_KEY: "",
    },
  });
  const B = srv.url;
  const offerOf = async (route, sql) => {
    const r = await fetch(`${B}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }), signal: AbortSignal.timeout(30_000) });
    const hdr = r.headers.get("payment-required");
    await r.arrayBuffer();
    const offer = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : {};
    return { status: r.status, offer, accept: (offer.accepts || []).find((x) => x.network === SOL && x.scheme === "exact") };
  };
  const walk = (extra = "") => `SELECT block_slot, block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_WEEK_MAX_DAYS} DAY AND executing_account = 'wk_walk'${extra}`;
  const week = await offerOf("/api/onchain-sql-week", walk());
  ok(week.status === 402 && !!week.accept, `the week route's 402 offers Solana exact (${week.status})`);
  const month = await offerOf("/api/onchain-sql-range", walk());
  ok(month.status === 402 && !month.accept && (month.offer.accepts || []).every((a) => a.network.startsWith("eip155:")), "the long-range route's 402 offers EVM only");
  if (!week.accept) throw new Error("no Solana offer to pay");

  const pay = async (sql) => {
    const tx = await paymentTx(buyer, Number(week.accept.amount));
    payments.set(tx, buyer.address);
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: week.offer.resource, accepted: week.accept, payload: { transaction: tx } })).toString("base64");
    const q0 = walkQueries, s0 = settles, t0 = Date.now();
    const r = await fetch(`${B}/api/onchain-sql-week`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: JSON.stringify({ sql }), signal: AbortSignal.timeout(90_000) });
    const text = await r.text();
    const ms = Date.now() - t0;
    await sleep(300); // nothing more may settle after the answer
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, ms, queries: walkQueries - q0, settles: settles - s0, charged: !!(r.headers.get("payment-response") || r.headers.get("x-payment-response")) };
  };
  const spans = () => { const now = Date.now(); let n = 1; for (let t = Math.floor((now - SQL_WEEK_MAX_DAYS * DAY) / DAY) * DAY + DAY; t < now; t += DAY) n++; return n; };
  const sortedAsc = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].block_time <= r.block_time);

  // ---- a week in one Solana-paid call ----
  {
    const n = spans();
    const r = await pay(walk());
    ok(r.status === 200 && r.json?.complete === true && r.json.rows.length === n * dayRows && sortedAsc(r.json.rows) && r.json.windowed?.daysRead === n, `a ${SQL_WEEK_MAX_DAYS}-day walk paid on Solana: every day merged in order (${r.status}, ${r.json?.rows?.length} rows, ${r.json?.windowed?.daysRead} days)`);
    ok(r.ms < SQL_WEEK_BUDGET_MS && r.queries === 1 + n && r.settles === 1 && r.charged, `answered in ${r.ms} ms, inside the ${SQL_WEEK_BUDGET_MS} ms Solana budget, on ${r.queries} queries, settled exactly once (${r.settles})`);
  }
  // ---- days too slow for the week: stopped on time, partial, still settles ----
  {
    dayMs = 6_000;
    const r = await pay(walk());
    dayMs = 300;
    const w = r.json?.windowed || {};
    ok(r.status === 200 && r.json?.complete === false && r.json.truncated === true && w.stoppedBy === "time" && w.daysRead >= 1 && w.daysRead < w.days && w.coveredFrom && w.coveredTo && sortedAsc(r.json.rows), `slow days end the walk on time: partial in fields (${r.status}, ${JSON.stringify(w)})`);
    ok(r.ms < SQL_WEEK_BUDGET_MS + 2_000 && r.settles === 1 && r.charged, `answered in ${r.ms} ms, inside the Solana budget plus its answer, settled once (${r.settles})`);
    ok((r.json?.longerRange || []).map((x) => x.path).join(",") === "/api/onchain-sql-range", `and names the long-range route (${JSON.stringify(r.json?.longerRange)})`);
  }
  // ---- nothing read: the uncharged 422 ----
  {
    dayRows = 0;
    const r = await pay(walk().replace(`INTERVAL ${SQL_WEEK_MAX_DAYS} DAY`, "INTERVAL 20 DAY"));
    dayRows = 2;
    ok(r.status === 422 && r.settles === 0 && !r.charged, `no rows in the days the week route may read: the uncharged 422, nothing settled (${r.status}, ${r.settles})`);
  }
  // ---- an aggregate, as onchain-sql ----
  {
    const r = await pay(`SELECT count() AS n FROM solana.instructions WHERE block_time > now() - INTERVAL ${SQL_WEEK_MAX_DAYS} DAY AND executing_account = 'wk_walk'`);
    ok(r.status === 422 && r.queries === 1 && r.settles === 0, `an aggregate past the window is not split: one query, the uncharged 422 (${r.status}, ${r.queries})`);
  }
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || e);
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  await srv?.stop();
  cdp.closeAllConnections?.(); cdp.close();
  side.closeAllConnections?.(); side.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
