#!/usr/bin/env node
// The per-chain spending-wallet words on /api/gateway-status answer within one
// deadline whatever the chain RPCs do (src/upstream-buyer-status.js
// upstreamBuyerEvmStatus).
//
// Five enabled chains, every RPC a local server that accepts and never
// answers: the whole read returns within EVM_STATUS_DEADLINE_MS (not one 6 s
// timeout per chain in turn), each chain reads "unknown", no figure. With one
// chain answering and four hanging, the answering chain still reads its word,
// so the chains are read side by side. A second call while the reads are
// still out sends no new request per chain. Offline: local sockets only.
//
//   node scripts/test-upstream-buyer-status.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

let hangHits = 0;
const hang = createServer(() => { hangHits++; /* never answers */ });
await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const hangUrl = `http://127.0.0.1:${hang.address().port}`;
// Answers every eth_call with 40 units of a 6-decimal token.
const answer = createServer((req, res) => {
  let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (40_000_000).toString(16).padStart(64, "0") }));
  });
});
await new Promise((r) => answer.listen(0, "127.0.0.1", r));
const answerUrl = `http://127.0.0.1:${answer.address().port}`;

const IDS = { arc: "5042", celo: "42220", polygon: "137", arbitrum: "42161", robinhood: "4663" };
process.env.SOR_EVM_CHAINS = Object.keys(IDS).join(",");
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
delete process.env.UPSTREAM_BUYER_LOW_USD;
for (const c of Object.keys(IDS)) delete process.env[`UPSTREAM_BUYER_LOW_USD_${c.toUpperCase()}`];
const setRpcs = (fn) => { for (const [c, id] of Object.entries(IDS)) process.env[`EVM_RPC_${id}`] = fn(c); };

const s = await import("../src/upstream-buyer-status.js");
const DEADLINE = s.EVM_STATUS_DEADLINE_MS;
ok(Number.isFinite(DEADLINE) && DEADLINE > 0 && DEADLINE <= 5_000, `the multi-chain read has one deadline inside the heartbeat's 15 s (${DEADLINE} ms)`);

try {
  // ---- every RPC hangs ------------------------------------------------------
  setRpcs(() => hangUrl);
  s.__resetEvmChainStatusForTest();
  let t = Date.now();
  const st = await s.upstreamBuyerEvmStatus();
  const ms = Date.now() - t;
  ok(ms < DEADLINE + 750, `five hanging RPCs: the read returns within the deadline (${ms} ms)`);
  ok(st.status === "unknown" && Object.keys(IDS).every((c) => st.chains?.[c]?.status === "unknown"), `five hanging RPCs: every chain reads unknown (${JSON.stringify(st)})`);
  // unknownForMinutes is the one number the word carries (how long it has read unknown).
  const { unknownForMinutes, ...words } = st;
  ok(!/\d/.test(JSON.stringify(words)) && Number.isInteger(unknownForMinutes), "words only, no figure besides unknownForMinutes");
  ok(hangHits === 5, `each chain's RPC was asked once (${hangHits})`);
  // A second read while those requests are still out waits on them: no new
  // request per chain.
  t = Date.now();
  await s.upstreamBuyerEvmStatus({ deadlineMs: 200 });
  ok(Date.now() - t < 950 && hangHits === 5, `a second read sends no second request per chain (${hangHits})`);

  // ---- one chain answers, four hang -------------------------------------------
  // Drop the earlier reads and let them land before the cache is cleared.
  hang.closeAllConnections();
  await new Promise((r) => setTimeout(r, 200));
  hangHits = 0;
  s.__resetEvmChainStatusForTest();
  setRpcs((c) => (c === "robinhood" ? answerUrl : hangUrl));
  t = Date.now();
  const mixed = await s.upstreamBuyerEvmStatus();
  const ms2 = Date.now() - t;
  ok(ms2 < DEADLINE + 750, `one answering, four hanging: within the deadline (${ms2} ms)`);
  ok(mixed.chains?.robinhood?.status === "ok" && ["arc", "celo", "polygon", "arbitrum"].every((c) => mixed.chains?.[c]?.status === "unknown"),
    `the answering chain reads its word beside four that cannot (${JSON.stringify(mixed)})`);
  ok(mixed.status === "unknown", "the summary word reads unknown while any chain is unread");

  // ---- every chain answers --------------------------------------------------
  hang.closeAllConnections();
  await new Promise((r) => setTimeout(r, 200));
  s.__resetEvmChainStatusForTest();
  setRpcs(() => answerUrl);
  t = Date.now();
  const all = await s.upstreamBuyerEvmStatus();
  ok(all.status === "ok" && Date.now() - t < DEADLINE, `five answering RPCs read ok well inside the deadline (${JSON.stringify(all)})`);

  // ---- the unknown-since clock survives a deploy through the shared store ----
  // A new process (the reset below) reads the first-unknown moment another
  // process stored, so an hour-long blind spell still pages after a deploy.
  const { __setTestClient } = await import("../src/shared-limit.js");
  const store = new Map();
  let dels = 0;
  const fake = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, o = {}) { if (o.NX && store.has(k)) return null; store.set(k, v); return "OK"; },
    async del(k) { dels++; return store.delete(k) ? 1 : 0; },
  };
  const blind = { readBalance: async () => { throw new Error("rpc down"); } };
  const readable = { readBalance: async () => 40 };
  const T0 = Date.now();
  const at = (min, o) => s.upstreamBuyerEvmStatus({ ...o, now: T0 + min * 60_000 });
  __setTestClient(fake);
  s.__resetEvmChainStatusForTest();
  const u0 = await at(0, blind);
  ok(u0.status === "unknown" && u0.unknownForMinutes === 0 && store.size === 1, `shared clock: the first unknown read stores its moment (${JSON.stringify(u0.unknownForMinutes)})`);
  s.__resetEvmChainStatusForTest(); // a deploy: a new process, the store kept
  const u61 = await at(61, blind);
  ok(u61.status === "unknown" && u61.unknownForMinutes === 61, `shared clock: after a deploy the clock runs on from the stored moment (${u61.unknownForMinutes})`);
  s.__resetEvmChainStatusForTest();
  const r = await at(62, readable);
  ok(r.status === "ok" && r.unknownForMinutes === undefined && store.size === 0, "shared clock: a readable read clears the stored moment");
  const d = dels;
  s.__resetEvmChainStatusForTest(); await at(63, readable);
  await at(64, readable);
  ok(dels === d + 1, `shared clock: a new process clears once, then not on every read (${dels - d})`);
  s.__resetEvmChainStatusForTest();
  const again = await at(70, blind);
  ok(again.unknownForMinutes === 0, "shared clock: a new blind spell starts its own clock");
  // A store that does not answer: process memory, inside the store deadline.
  __setTestClient({ get: () => new Promise(() => {}), set: () => new Promise(() => {}), del: () => new Promise(() => {}) });
  s.__resetEvmChainStatusForTest();
  t = Date.now();
  const hung = await at(80, blind);
  ok(hung.unknownForMinutes === 0 && Date.now() - t < s.EVM_UNKNOWN_STORE_MS + 500, `shared clock: a hanging store falls back to process memory within its deadline (${Date.now() - t} ms)`);
  ok((await at(95, blind)).unknownForMinutes === 15, "shared clock: the process clock then runs");
  // No store: per process, as before.
  __setTestClient(null);
  s.__resetEvmChainStatusForTest();
  await at(0, blind);
  ok((await at(30, blind)).unknownForMinutes === 30, "no store: the process clock runs");
  s.__resetEvmChainStatusForTest();
} finally {
  hang.closeAllConnections(); hang.close();
  answer.closeAllConnections(); answer.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
