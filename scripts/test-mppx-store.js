// mppx's own Tempo charge replay claims live in src/mppx-store.js: Redis when
// REDIS_URL is set (shared by every replica), this process's memory otherwise.
//
//   - the store: a claim is first-use only, a released claim can be made
//     again, update() is compare-and-set, values keep bigints;
//   - two stores over ONE redis (two replicas) see each other's claims, and
//     a store whose redis fails falls back to its own memory and says so;
//   - the caller path, in direct mode (TEMPO_RELAY=off): a push credential
//     settled through broadcastTempoCredential is refused on a SECOND replica
//     (its own method and store over the same redis) with mppx's
//     CredentialReplayedError, which the gate classifies as its "replay"
//     refusal; a replica with a private memory store (the control) accepts the
//     same credential, so the shared store is what refuses it;
//   - building the method warns nothing about an in-memory store.
// Offline: the chain and redis are stubs; nothing moves.
//   node scripts/test-mppx-store.js
import { Challenge, Credential, Method, Store } from "mppx";
import { tempo } from "mppx/server";
import { Attribution } from "mppx/tempo";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { Abis } from "viem/tempo";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A node-redis-shaped fake: GET, SET (NX, PX), DEL and the one EVAL script the
// store sends (compare-and-set), over one Map with expiries. Two stores handed
// the same fake are two replicas on one redis.
function fakeRedis() {
  const data = new Map();
  const live = (k) => { const e = data.get(k); if (!e) return null; if (e.at && e.at <= Date.now()) { data.delete(k); return null; } return e; };
  return {
    data,
    calls: [],
    async get(k) { this.calls.push("get"); return live(k)?.v ?? null; },
    async set(k, v, opt = {}) {
      this.calls.push("set");
      if (opt.NX && live(k)) return null;
      data.set(k, { v, at: opt.PX ? Date.now() + opt.PX : 0 });
      return "OK";
    },
    async del(k) { this.calls.push("del"); return data.delete(k) ? 1 : 0; },
    async eval(_script, { keys: [k], arguments: [expectAbsent, expected, op, value, px] }) {
      this.calls.push("eval");
      const cur = live(k)?.v ?? null;
      if (expectAbsent === "1" ? cur !== null : cur !== expected) return 0;
      if (op === "set") data.set(k, { v: value, at: Date.now() + Number(px) });
      else data.delete(k);
      return 1;
    },
  };
}

const { createMppxStore, MPPX_STORE_PREFIX } = await import("../src/mppx-store.js");

// --- the store on its own -----------------------------------------------------
{
  const mem = createMppxStore({ getClient: async () => null });
  ok(await mem.backend() === "memory", "no redis configured: the store is this process's memory");
  const exp = Date.now() + 60_000;
  ok(await mem.tryClaim("mppx:charge:0xaa", exp) === true, "memory: the first claim is granted");
  ok(await mem.tryClaim("mppx:charge:0xaa", exp) === false, "memory: a second claim of the same key is refused");
  await mem.delete("mppx:charge:0xaa");
  ok(await mem.tryClaim("mppx:charge:0xaa", exp) === true, "memory: a released claim can be made again");

  const redis = fakeRedis();
  const a = createMppxStore({ getClient: async () => redis });
  const b = createMppxStore({ getClient: async () => redis });
  ok(await a.backend() === "redis", "redis configured: the store writes to redis");
  ok(await a.tryClaim("mppx:charge:0xbb", exp) === true, "replica A claims a hash");
  ok(await b.tryClaim("mppx:charge:0xbb", exp) === false, "replica B, same redis, is refused the same hash");
  const entry = redis.data.get(`${MPPX_STORE_PREFIX}mppx:charge:0xbb`);
  ok(entry && entry.at > Date.now() && entry.at <= exp + 1000, "the claim expires with the challenge, so redis keeps no spent markers");
  await a.delete("mppx:charge:0xbb");
  ok(await b.tryClaim("mppx:charge:0xbb", exp) === true, "after A releases the claim, B can make it");

  // update(): compare-and-set, bigints intact, and a race is retried.
  await a.put("k:budget", { n: 1n });
  const got = await b.get("k:budget");
  ok(got && got.n === 1n, "a value written by one replica reads back on another with its bigint intact");
  const r = await a.update("k:budget", (cur) => ({ op: "set", value: { n: cur.n + 1n }, result: "done" }));
  ok(r === "done" && (await b.get("k:budget")).n === 2n, "update applies its change and returns its result");
  // Write a fresh value under the CAS, then let the retry read it.
  await a.put("k:race", { n: 10n });
  let seen = [];
  const raceStore = createMppxStore({ getClient: async () => ({
    get: redis.get.bind(redis), set: redis.set.bind(redis), del: redis.del.bind(redis),
    async eval(s, o) {
      // A concurrent writer lands between the first read and its write.
      if (seen.length === 1) await a.put("k:race", { n: 20n });
      return redis.eval(s, o);
    },
  }) });
  await raceStore.update("k:race", (cur) => { seen.push(cur.n); return { op: "set", value: { n: cur.n + 1n }, result: true }; });
  ok(seen.length === 2 && seen[1] === 20n && (await a.get("k:race")).n === 21n, `a write that lost a race is recomputed from the newer value (read ${seen.join(" then ")})`);
  const d = await a.update("k:race", () => ({ op: "delete", result: "gone" }));
  ok(d === "gone" && (await b.get("k:race")) === null, "update can delete");

  // Redis failing: fall back to this process's memory, and say so.
  const logs = [];
  const broken = createMppxStore({ getClient: async () => ({ get: async () => { throw new Error("ECONNRESET"); }, set: async () => { throw new Error("ECONNRESET"); }, del: async () => { throw new Error("ECONNRESET"); }, eval: async () => { throw new Error("ECONNRESET"); } }), log: (m) => logs.push(m) });
  ok(await broken.tryClaim("mppx:charge:0xcc", exp) === true && await broken.tryClaim("mppx:charge:0xcc", exp) === false, "redis failing: claims still hold within this process");
  ok(logs.length === 1 && /redis tryClaim failed/.test(logs[0]) && /not shared/.test(logs[0]), "the degraded path logs once (rate-limited), naming that claims are not shared");
}

// --- the caller path: a push credential through the real gate functions --------
const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const PAYER = "0x5555555555555555555555555555555555555555";
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
const SECRET = "mppx-store-secret";
const REALM = "test.local";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = USDC_E;
process.env.TEMPO_RELAY = "off";
delete process.env.TEMPO_API_KEY;
process.env.SANCTIONS_SCREEN_FILE = join(tmpdir(), `mppx-store-screen-${process.pid}.json`);

const shared = fakeRedis();
const sharedLimit = await import("../src/shared-limit.js");
sharedLimit.__setTestClient(shared);

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); realWarn(...a); };

// The chain: every receipt lookup answers a successful transfer of the
// challenge amount to us, memo bound to the challenge being presented.
let currentChallenge = null;
const realFetch = globalThis.fetch;
const HASH = "0x" + "ab".repeat(32);
const transferWithMemo = Abis.tip20.find((x) => x.type === "event" && x.name === "TransferWithMemo");
function receiptFor(ch) {
  const memo = Attribution.encode({ challengeId: ch.id, serverId: ch.realm });
  const topics = encodeEventTopics({ abi: [transferWithMemo], eventName: "TransferWithMemo", args: { from: PAYER, to: TREASURY, memo } });
  const data = encodeAbiParameters([{ type: "uint256" }], [BigInt(ch.request.amount)]);
  const blk = "0x" + "11".repeat(32);
  return {
    transactionHash: HASH, transactionIndex: "0x0", blockHash: blk, blockNumber: "0x10", from: PAYER, to: USDC_E,
    cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, status: "0x1", type: "0x76", logsBloom: "0x" + "00".repeat(256),
    logs: [{ address: USDC_E, topics, data, logIndex: "0x0", blockNumber: "0x10", blockHash: blk, transactionHash: HASH, transactionIndex: "0x0", removed: false }],
  };
}
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (/ofac|treasury\.gov|sanctions/i.test(url)) return realFetch(input, init);
  let body = {};
  try { body = JSON.parse(String(init?.body || "{}")); } catch { /* not json */ }
  const answer = (one) => {
    if (one.method === "eth_chainId") return { jsonrpc: "2.0", id: one.id, result: "0x1079" };
    if (one.method === "eth_getTransactionReceipt" && currentChallenge) return { jsonrpc: "2.0", id: one.id, result: receiptFor(currentChallenge) };
    return { jsonrpc: "2.0", id: one.id, error: { code: -32000, message: "stub rpc" } };
  };
  const out = Array.isArray(body) ? body.map(answer) : answer(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};

const screen = await import("../src/sanctions-screen.js");
const fixture = readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
await screen.refreshSanctionsScreen({ fetchImpl: async () => new Response(fixture, { status: 200 }), log: () => {} });

const tempoMod = await import("../src/mpp-tempo.js");
const { broadcastTempoCredential, classifyTempoRefusal, mintTempoChallenge, tempoEnabled } = tempoMod;
ok(tempoEnabled() === true && tempoMod.tempoSettlementMode() === "direct", "direct mode is enabled with the screen loaded");

const header = mintTempoChallenge({ priceUsd: 0.01, realm: REALM, secretKey: SECRET });
ok(!warnings.some((w) => /in-memory store/.test(w)), "building the tempo method warns nothing about an in-memory store (it was handed one)");
const ch = Challenge.deserialize(header);
currentChallenge = ch;
const credential = Credential.serialize({ challenge: ch, payload: { type: "hash", hash: HASH }, source: `did:pkh:eip155:4217:${PAYER}` });

const first = await broadcastTempoCredential(credential);
ok(first.ok === true && first.receipt?.reference === HASH, `replica 1 settles the push credential (${first.ok ? first.receipt?.reference : first.error})`);
ok([...shared.data.keys()].some((k) => k === `${MPPX_STORE_PREFIX}mppx:charge:${HASH}`), "its hash claim is in the shared redis, under the store's prefix");

const again = await broadcastTempoCredential(credential);
ok(again.ok === false && again.cls === "replay", `the same replica refuses it again as a replay (cls=${again.cls})`);

// Replica 2: its own mppx method and its own store object, over the same redis.
const replica2 = tempo.charge({ currencies: [USDC_E], recipient: TREASURY, store: createMppxStore({ getClient: async () => shared }) });
let err2 = null;
try { await Method.broadcastCredential(replica2, credential); } catch (e) { err2 = e; }
ok(err2?.name === "CredentialReplayedError", `replica 2 is refused the credential replica 1 settled (${err2?.name || "accepted"})`);
ok(err2 && classifyTempoRefusal(err2) === "replay", "and the gate classifies mppx's CredentialReplayedError as its replay refusal");
const problem = tempoMod.tempoRefusalProblem(classifyTempoRefusal(err2));
ok(problem.status === 402 && problem.type.endsWith("invalid-challenge") && problem.details?.reason === "replay" && problem.details?.charged === false, `the refusal is the existing replay shape: 402 invalid-challenge, details.reason "replay", charged false (${problem.status} ${problem.type})`);

// Control: a replica with a private in-memory store accepts it, so it is the
// shared store, not anything else in the credential, that refuses it above.
const control = tempo.charge({ currencies: [USDC_E], recipient: TREASURY, store: Store.memory() });
let ctl = null, ctlErr = null;
try { ctl = await Method.broadcastCredential(control, credential); } catch (e) { ctlErr = e; }
ok(ctl?.reference === HASH, `control: a replica on a private memory store accepts the same credential (${ctl?.reference || ctlErr?.message})`);

// A transfer whose memo is bound to ANOTHER challenge keeps its old class.
const other = Challenge.deserialize(mintTempoChallenge({ priceUsd: 0.01, realm: REALM, secretKey: SECRET }));
currentChallenge = other; // the chain's transfer is bound to `other`
const misbound = Credential.serialize({ challenge: ch, payload: { type: "hash", hash: "0x" + "cd".repeat(32) }, source: `did:pkh:eip155:4217:${PAYER}` });
const mb = await broadcastTempoCredential(misbound);
ok(mb.ok === false && mb.cls === "memo-unbound", `a settled transfer bound to another challenge stays "memo-unbound", not a replay (cls=${mb.cls})`);

console.warn = realWarn;
globalThis.fetch = realFetch;
try { rmSync(process.env.SANCTIONS_SCREEN_FILE, { force: true }); } catch { /* nothing to remove */ }
console.log(`test-mppx-store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
