#!/usr/bin/env node
// onchain-sql on the paid path, with the facilitator wired as production
// wires it: CDP keys set and no CDP_FACILITATOR_URL, so the server registers
// the keyed CDP client at its production URL. scripts/lib/cdp-origin-preload.js
// sends every fetch to that origin (the facilitator's verify, settle and
// supported, and the query service) to a stand-in in THIS process, so every
// event is stamped on one clock; any other host is refused in process. The
// suites that pay for onchain-sql elsewhere point the facilitator at a URL
// override, which is a different client registration.
//
// A buyer pays on Solana (exact). Asserted:
//   - a paid query reaches the query service within 300 ms of its own
//     payment's verify answer, with nothing else on the server;
//   - the same, and the query is served (200, settled once), while
//       1. another wallet buys another route back to back through the same
//          facilitator client,
//       2. another payment's settle takes 8 s,
//       3. a sender with no funds sends payments the facilitator refuses at
//          verify, one after another;
//   - two of the buyer's own calls 200 ms apart are both served, the one
//     whose query leaves second no later than one send gap past that bound;
//   - a 200 from the query service whose body cannot be read (truncated
//     JSON, a connection reset part way, an empty body, an HTML page) is a
//     502 with nothing settled, a real answer with no rows is a 200 settled
//     once, and the next paid query is served as promptly as the first.
// What a paid call's query may wait on is the send pacer alone
// (src/tools/cdp-kit.js: one send per CDP_SQL_SEND_GAP_MS): a facilitator
// call, the buyer's own or anyone's, holds no query back.
//
// Deterministic: the buyer's sequential calls are sent a full send gap after
// the last query the stand-in received, so no call waits on the pacer by
// timing; the 300 ms bound is the only one that reads the machine. The
// server's own economy read is run first (it shares the pacer), and a query
// the test did not send fails the run by name.
//
//   node scripts/test-onchain-sql-paid-path.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

const kit = await import("@solana/kit");
const { sqlSendGapMs } = await import("../src/tools/cdp-kit.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return true; await sleep(10); } return fn(); };

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// The bound under test: a query leaves within this of its own verify answer.
const OWN_VERIFY_TO_QUERY_MS = 300;
// The shipped send gap for one replica (the boot below sets neither knob).
const GAP = sqlSendGapMs({ RATE_LIMIT_REPLICAS: "1" });
// What the stand-in takes to answer, in ms: fixed, far under the bounds read.
const LAT = { verify: 150, settle: 300, query: 200 };

const feePayer = await kit.generateKeyPairSigner();
const payTo = await kit.generateKeyPairSigner();
const buyer = await kit.generateKeyPairSigner();
const other = await kit.generateKeyPairSigner();
const b58 = kit.getBase58Decoder();

// ---- the CDP origin, in this process ---------------------------------------------
// wire transaction -> { tag, payer, refuse, settleMs }: how the stand-in answers
// that payment, and the name its events carry.
const payments = new Map();
const events = []; // { kind: verify|settle|query|schema|supported|other, tag, t0, t1 }
const cdp = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const reply = (status, obj) => { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { /* empty */ }
    const [path] = req.url.split("?");
    const ev = { kind: "other", tag: null, t0: Date.now(), t1: null };
    events.push(ev);
    const answer = (status, obj) => { ev.t1 = Date.now(); reply(status, obj); };
    if (path === "/platform/v2/x402/supported") {
      ev.kind = "supported";
      return answer(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    }
    if (path === "/platform/v2/x402/verify" || path === "/platform/v2/x402/settle") {
      const p = payments.get(j?.paymentPayload?.payload?.transaction) || {};
      ev.kind = path.endsWith("/verify") ? "verify" : "settle";
      ev.tag = p.tag ?? null;
      if (ev.kind === "verify") {
        await sleep(LAT.verify);
        // A wallet with no funds, in the facilitator's own words for it.
        if (p.refuse) return answer(200, { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_simulation_failed", invalidMessage: "transaction simulation failed: InstructionError:[2 map[Custom:1]]", payer: p.payer });
        return answer(200, { isValid: true, payer: p.payer });
      }
      await sleep(p.settleMs ?? LAT.settle);
      // Each settle names its own transaction: one Solana transaction answers one request.
      return answer(200, { success: true, transaction: b58.decode(randomBytes(64)), network: SOL, payer: p.payer });
    }
    if (path === "/platform/v2/data/query/run") {
      const sql = String(j?.sql || "");
      ev.kind = "query"; ev.sql = sql; ev.tag = /\bpp_(\w+)/.exec(sql)?.[1] ?? null;
      await sleep(LAT.query);
      // A tag names an answer that is a 200 and cannot be read, or holds no rows.
      const how = /^(cut|reset|empty|html|zero)\d/.exec(ev.tag || "")?.[1];
      if (how === "zero") return answer(200, { result: [] });
      if (how && !res.destroyed) {
        ev.t1 = Date.now();
        if (how === "cut") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"result":[{"n":1},{"n"'); }
        if (how === "empty") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "0" }); return res.end(); }
        if (how === "html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body><h1>502 Bad Gateway</h1></body></html>"); }
        // The connection closes part way through a body whose length was announced.
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
        res.write('{"result":[{"n":1},');
        return setTimeout(() => res.destroy(), 20);
      }
      return answer(200, { result: [{ n: 1 }] });
    }
    if (path === "/platform/v2/data/query/schema") { ev.kind = "schema"; return answer(200, { "base.blocks": [{ name: "block_number", type: "UInt64" }] }); }
    return answer(404, { errorMessage: "not stubbed" });
  });
});
await new Promise((r) => cdp.listen(0, "127.0.0.1", r));

// The second facilitator's slot and the Base RPC. CDP is registered first and
// lists both networks, so this facilitator must never be asked to verify or settle.
let sideFacilitatorCalls = 0;
const side = createServer((req, res) => {
  req.resume(); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const [path] = req.url.split("?");
    if (path === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
    if (path === "/verify" || path === "/settle") { sideFacilitatorCalls++; return reply(500, { error: "the second facilitator is never asked in this suite" }); }
    if (path === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => side.listen(0, "127.0.0.1", r));
const SIDE = `http://127.0.0.1:${side.address().port}`;

// ---- an exact-scheme Solana payment (as scripts/test-top-buyer-failures.js builds one) ----
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
    args: ["--import", "./scripts/lib/cdp-origin-preload.js"], stores: "sql-paid-path",
    env: {
      FREE_MODE: "", NODE_ENV: "",
      CDP_ORIGIN_STUB: "1", CDP_ORIGIN_STUB_PORT: String(cdp.address().port),
      // Keys set and no URL override: the keyed CDP client, as in production.
      CDP_API_KEY_ID: "organizations/test/apiKeys/test", CDP_API_KEY_SECRET: privateKey.export({ type: "pkcs8", format: "pem" }),
      CDP_FACILITATOR_URL: "", FACILITATOR_URL: "", SOLANA_FACILITATOR_URL: "", SOLANA_FACILITATOR_SHARE: "",
      PAYAI_FACILITATOR_URL: SIDE, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,solana", SOLANA_WALLET_ADDRESS: payTo.address,
      AGENT402_BASE_RPC: `${SIDE}/rpc`, MPP_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", FIRST_CALL_ALLOWANCE: "",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
      // The shipped pacer and cap for one replica: no override.
      ONCHAIN_SQL_INFLIGHT_MAX: "", CDP_SQL_SEND_GAP_MS: "", RATE_LIMIT_REPLICAS: "1",
      STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", RECEIPT_SIGNING_KEY: "",
    },
  });
  const B = srv.url;
  ok(/Facilitator: Coinbase CDP \(Bazaar discovery enabled\)/.test(srv.log()) && !/Facilitator: CDP at .* \(URL override\)/.test(srv.log()),
    "the server registers the keyed CDP facilitator client at its production URL (no URL override)");
  ok(events.some((e) => e.kind === "supported"), "and that client's calls reach the stand-in through the production origin");

  const offerOf = async (route, init) => {
    const r = await fetch(`${B}${route}`, { ...init, signal: AbortSignal.timeout(30_000) });
    const hdr = r.headers.get("payment-required");
    await r.arrayBuffer();
    const offer = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : {};
    return { status: r.status, offer, accept: (offer.accepts || []).find((x) => x.network === SOL && x.scheme === "exact") };
  };
  const sqlOffer = await offerOf("/api/onchain-sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1 AS n FROM base.blocks" }) });
  const uuidOffer = await offerOf("/api/uuid", { method: "GET" });
  ok(sqlOffer.status === 402 && !!sqlOffer.accept && uuidOffer.status === 402 && !!uuidOffer.accept, `onchain-sql and another route both offer Solana exact (${sqlOffer.status}, ${uuidOffer.status})`);
  if (!sqlOffer.accept || !uuidOffer.accept) throw new Error("no Solana offer to pay");

  const send = async (o, signer, how, route, init) => {
    const tx = await paymentTx(signer, Number(o.accept.amount));
    payments.set(tx, { payer: signer.address, ...how });
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: o.offer.resource, accepted: o.accept, payload: { transaction: tx } })).toString("base64");
    const sentAt = Date.now();
    const r = await fetch(`${B}${route}`, { ...init, headers: { ...(init.headers || {}), "payment-signature": header }, signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { tag: how.tag, status: r.status, body, sentAt, doneAt: Date.now(), retryAfter: r.headers.get("retry-after"), charged: !!(r.headers.get("payment-response") || r.headers.get("x-payment-response")) };
  };
  /** One paid onchain-sql call by `signer`; its query carries `tag`. */
  const sqlCalls = [];
  const paySql = async (tag, how = {}, signer = buyer) => { const r = await send(sqlOffer, signer, { tag, ...how }, "/api/onchain-sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: `SELECT 1 AS pp_${tag} FROM base.blocks` }) }); sqlCalls.push(r); return r; };
  /** One paid call of the other route (no query, no send slot) by `signer`. */
  const payOther = (tag, how = {}, signer = other) => send(uuidOffer, signer, { tag, ...how }, "/api/uuid", { method: "GET" });

  const ev = (kind, tag) => events.find((e) => e.kind === kind && e.tag === tag);
  /** ms from the answer to this call's verify to its query reaching the query service. */
  const waitOf = (tag) => { const v = ev("verify", tag), q = ev("query", tag); return v?.t1 != null && q ? q.t0 - v.t1 : null; };
  /** Whether a facilitator call named by `re` was in flight, or had ended within one send gap, when this call's query was sent. */
  const facilitatorBusyAt = (tag, re) => { const q = ev("query", tag); return !!q && events.some((e) => (e.kind === "verify" || e.kind === "settle") && re.test(e.tag || "") && e.t0 <= q.t0 && (e.t1 === null || e.t1 >= q.t0 - GAP)); };
  // A sequential call is sent a full send gap after the last query the
  // stand-in received: the pacer's next slot is then open whatever the load.
  const pacerClear = async () => { const last = Math.max(0, ...events.filter((e) => e.kind === "query").map((e) => e.t0)); const wait = last + GAP + 75 - Date.now(); if (wait > 0) await sleep(wait); };
  const describe = (calls) => calls.map((c) => `${c.status}${c.status === 200 ? "" : `:${String(c.body?.error || "").slice(0, 60)}`} wait ${waitOf(c.tag)} ms`).join("; ");
  const served = (calls) => calls.every((c) => c.status === 200 && c.charged);
  const prompt = (calls, bound = OWN_VERIFY_TO_QUERY_MS) => calls.every((c) => { const w = waitOf(c.tag); return w !== null && w <= bound; });

  // The server's own economy read goes through the same pacer: run it now, so
  // its boot warm-up finds the snapshot and sends nothing during a measurement.
  const econ = await fetch(`${B}/api/x402-economy`, { signal: AbortSignal.timeout(60_000) });
  await econ.arrayBuffer();
  const ownBefore = events.filter((e) => e.kind === "query").length;
  ok(econ.status === 200 && ownBefore >= 1, `the server's own economy read has run before any measurement (${econ.status}, ${ownBefore} queries)`);

  // ---- alone ----
  const alone = [];
  for (let i = 0; i < 2; i++) { await pacerClear(); alone.push(await paySql(`alone${i}`)); }
  ok(served(alone), `a paid query on Solana is served and settled (${describe(alone)})`);
  ok(prompt(alone), `with nothing else on the server its query reaches the query service within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${alone.map((c) => waitOf(c.tag)).join(", ")} ms)`);

  // ---- 1. another wallet buys another route back to back, same facilitator client ----
  {
    let stop = false; const bought = [];
    const loop = (async () => { for (let i = 0; !stop; i++) bought.push((await payOther(`other${i}`)).status); })();
    await until(() => bought.length >= 2);
    const calls = [];
    for (let i = 0; i < 3; i++) { await pacerClear(); calls.push(await paySql(`cross${i}`)); }
    stop = true; await loop;
    ok(bought.length >= 2 && bought.every((s) => s === 200), `another wallet buys another route back to back through the same facilitator client (${bought.length} buys, statuses ${[...new Set(bought)].join(",")})`);
    ok(calls.every((c) => facilitatorBusyAt(c.tag, /^other\d+$/)), "each of the buyer's queries was sent while one of that wallet's facilitator calls was in flight or had just ended");
    ok(served(calls), `the buyer's paid queries are served meanwhile, none refused (${describe(calls)})`);
    ok(prompt(calls), `and each leaves within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${calls.map((c) => waitOf(c.tag)).join(", ")} ms)`);
  }

  // ---- 2. another payment's settle takes 8 s ----
  {
    const slow = payOther("slow", { settleMs: 8_000 });
    await until(() => !!ev("settle", "slow"));
    const calls = [];
    for (let i = 0; i < 2; i++) { await pacerClear(); calls.push(await paySql(`slow${i}`)); }
    const stillSettling = ev("settle", "slow")?.t1 === null;
    ok(stillSettling && calls.every((c) => facilitatorBusyAt(c.tag, /^slow$/)), "another payment's settle is in flight (8 s) through both of the buyer's calls");
    ok(served(calls), `the buyer's paid queries are served during that settle, none refused (${describe(calls)})`);
    ok(prompt(calls), `and each leaves within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${calls.map((c) => waitOf(c.tag)).join(", ")} ms)`);
    const s = await slow;
    const took = ev("settle", "slow");
    ok(s.status === 200 && took?.t1 - took?.t0 >= 7_900, `the slow payment itself settles and is served (${s.status} after a ${took?.t1 - took?.t0} ms settle)`);
  }

  // ---- 3. a sender with no funds: verifies the facilitator refuses, one after another ----
  {
    let stop = false; const refused = [];
    const loop = (async () => { for (let i = 0; !stop; i++) refused.push((await payOther(`nofunds${i}`, { refuse: true }, await kit.generateKeyPairSigner())).status); })();
    await until(() => refused.length >= 2);
    const calls = [];
    for (let i = 0; i < 3; i++) { await pacerClear(); calls.push(await paySql(`unfunded${i}`)); }
    stop = true; await loop;
    const refusedVerifies = events.filter((e) => e.kind === "verify" && /^nofunds\d+$/.test(e.tag || "")).length;
    ok(refused.length >= 2 && refused.every((s) => s === 402) && refusedVerifies === refused.length && !events.some((e) => e.kind === "settle" && /^nofunds/.test(e.tag || "")),
      `a sender with no funds is refused at verify every time, each attempt reaching the facilitator, nothing settled (${refused.length} attempts, ${refusedVerifies} verifies, statuses ${[...new Set(refused)].join(",")})`);
    ok(calls.every((c) => facilitatorBusyAt(c.tag, /^nofunds\d+$/)), "each of the buyer's queries was sent while one of those verifies was in flight or had just ended");
    ok(served(calls), `the buyer's paid queries are served meanwhile, none refused (${describe(calls)})`);
    ok(prompt(calls), `and each leaves within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${calls.map((c) => waitOf(c.tag)).join(", ")} ms)`);
  }

  // ---- 4. two of the buyer's own calls 200 ms apart (the first one's settle takes 2 s) ----
  {
    await pacerClear();
    const first = paySql("pairA", { settleMs: 2_000 });
    await sleep(200);
    const second = paySql("pairB");
    const calls = await Promise.all([first, second]);
    // The second arrived behind the first and before the first had settled.
    const vA = ev("verify", "pairA"), vB = ev("verify", "pairB"), sA = ev("settle", "pairA");
    ok(!!vA && !!vB && !!sA && vB.t0 > vA.t0 && vB.t0 < sA.t1, `the second call's payment reached the facilitator ${vB && vA ? vB.t0 - vA.t0 : "?"} ms after the first one's, before the first had settled`);
    ok(served(calls), `two of the buyer's calls 200 ms apart are both served, neither refused (${describe(calls)})`);
    // Read in the order the two queries left, whichever call that was.
    const [lead, behind] = [...calls].sort((x, y) => (ev("query", x.tag)?.t0 ?? Infinity) - (ev("query", y.tag)?.t0 ?? Infinity));
    ok(prompt([lead]), `the query that leaves first does so within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${waitOf(lead.tag)} ms)`);
    ok(prompt([behind], GAP + OWN_VERIFY_TO_QUERY_MS), `the other waits for its send slot only: no more than one send gap past the same bound (${waitOf(behind.tag)} ms, gap ${GAP} ms)`);
  }

  // ---- 5. a 200 from the query service that cannot be read is never an answer ----
  {
    const unread = [];
    for (const how of ["cut", "reset", "empty", "html"]) { await pacerClear(); unread.push(await paySql(`${how}0`)); }
    ok(unread.every((c) => c.status === 502 && /answer could not be read \(cut off, empty or not JSON\); retry shortly\. Nothing was charged\.$/.test(String(c.body?.error || ""))),
      `a 200 whose body is truncated JSON, reset part way, empty or an HTML page is a 502 that says to retry (${unread.map((c) => `${c.tag} ${c.status}${c.status === 200 ? ` rowCount ${c.body?.rowCount}` : ""}`).join(", ")})`);
    ok(unread.every((c) => !c.charged && !ev("settle", c.tag)), `none of them is settled or carries a payment response (${unread.filter((c) => c.charged || ev("settle", c.tag)).map((c) => c.tag).join(", ") || "none charged"})`);
    await pacerClear();
    const zero = await paySql("zero0");
    ok(zero.status === 200 && zero.charged && !!ev("settle", "zero0") && zero.body?.rowCount === 0 && Array.isArray(zero.body?.rows) && zero.body.complete === true,
      `a real answer with no rows is a 200, settled once (${zero.status}, rowCount ${zero.body?.rowCount}, complete ${zero.body?.complete})`);
    await pacerClear();
    const next = await paySql("next0");
    ok(served([next]) && next.body?.rowCount === 1 && prompt([next]), `the in-flight place and the send slot are free again: the next paid query is served within ${OWN_VERIFY_TO_QUERY_MS} ms of its own verify answer (${describe([next])})`);
  }

  // ---- the whole run ----
  const queriesOf = (tag) => events.filter((e) => e.kind === "query" && e.tag === tag).length;
  const settlesOf = (tag) => events.filter((e) => e.kind === "settle" && e.tag === tag).length;
  const answered = sqlCalls.filter((c) => c.status === 200), refusedCalls = sqlCalls.filter((c) => c.status !== 200);
  ok(sqlCalls.length === 18 && answered.length === 14 && sqlCalls.every((c) => queriesOf(c.tag) === 1) && answered.every((c) => settlesOf(c.tag) === 1 && c.charged) && refusedCalls.every((c) => settlesOf(c.tag) === 0 && !c.charged),
    `every paid query was sent once; each answered one was settled once and nothing else was settled (${sqlCalls.length} calls, ${answered.length} answered, ${sqlCalls.reduce((n, c) => n + settlesOf(c.tag), 0)} settles)`);
  ok(sideFacilitatorCalls === 0, `the second facilitator was never asked (${sideFacilitatorCalls})`);
  const stray = events.filter((e) => e.kind === "query" && !e.tag).slice(ownBefore);
  ok(stray.length === 0, `no query the test did not send reached the query service during the measurements (${stray.map((e) => e.sql.replace(/\s+/g, " ").slice(0, 50)).join(" | ") || "none"})`);
  const outside = (srv.log().match(/\[cdp-origin-preload\] egress refused (\S+)/g) || []).filter((l) => /agent402|coinbase/i.test(l));
  ok(outside.length === 0, `no call left for the real CDP origin or this service's own host (${outside.join(", ") || "none"})`);
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
