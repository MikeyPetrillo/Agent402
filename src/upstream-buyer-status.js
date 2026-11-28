// Upstream-buyer balance status: the gateway-credits pattern (llm-gateway-kit
// gatewayCreditsStatus) applied to the x402 SPENDING wallet on Base
// (X402_UPSTREAM_BUYER_KEY). route-execute and seller-payability pay external
// sellers in USDC from it; when that runs dry they refuse (buyers are never
// charged), so the heartbeat alarms on "low" BEFORE that happens.
//
// attest signs from the same wallet but pays Base gas in ETH, which this reads
// nothing about: a USDC-empty wallet does not stop it, and the ETH-empty wallet
// that does is invisible here. attest bounds its own gas (ATTEST_MAX_GAS_USD)
// and refuses 503 uncharged; do not read this status as covering it.
// Bucketed status only: the balance number never leaves the server. 5-min
// cache; public-RPC read with graceful "unknown" (an RPC flake must never page).
import { noteFundingReading } from "./funding-runway.js";
const BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Sized against the LARGEST single spend this wallet can be asked to make, not
// against the smallest.
//
// A small default was right when the only thing spending from here was a
// fraction-of-a-cent data purchase. Then route-execute-pro made a single call
// able to spend dollars upstream, and "ok" would have meant "holds more than
// the old floor" for a wallet that could not cover one call. The alarm would
// have stayed green right up to the failure it exists to prevent.
//
// Two largest-tier calls, so we are paged with room to top up rather than at
// the moment of starvation. MUST be re-sized whenever a bigger execution tier
// lands - locked by an assertion in scripts/test-route-execute.js, because a
// threshold that quietly stops covering the biggest call reports nothing.
export const BUYER_LOW_DEFAULT_USD = 6;

// THIS WALLET SHOULD NEVER GO DOWN, so a fall is worth more than a floor.
//
// The route-execute tiers that spend from it also settle INTO it:
// SELF_FUNDING_SLUGS sets payTo to this address for exactly those tools
// (payments.js acceptsForItem), and every execution tier charges more than it
// can spend. seller-payability and attest are NOT in that set - they spend
// without refilling - which is why the fall has a tolerance and has to persist
// across reads rather than tripping on the first dip. So the trend a healthy
// wallet shows is flat or rising, and a SUSTAINED fall past the tolerance
// means something we do not understand is happening: the verify-then-fail-to-
// settle drain, a spend whose revenue never arrived, or a withdrawal nobody
// mentioned.
//
// A low-water alarm fires after the money is gone. This fires on the first
// unexplained dollar, which is the whole difference.
//
// It must tolerate a TRANSIENT dip, because settlement ordering guarantees one:
// we pay the seller during the handler and collect afterwards, so the balance
// is legitimately lower in between. Hence a high-water mark, a tolerance, and a
// requirement that the fall persist across consecutive reads (each 5 min apart)
// before it is called draining.
const BUYER_DROP_TOLERANCE_USD = Number(process.env.UPSTREAM_BUYER_DROP_TOLERANCE_USD || 0.5);
const BUYER_DROP_READS = Number(process.env.UPSTREAM_BUYER_DROP_READS || 3);

// The trend state: the high-water mark, the count of consecutive reads below
// it past the tolerance, and when an operator last acknowledged a fall. Kept
// in the state database when one is configured (src/json-document.js, one
// small document shared across replicas and deploys), in the file named by
// UPSTREAM_BUYER_TREND_FILE without one, and in process memory otherwise. So
// a restart neither forgets a real drain (the count carries on) nor reopens
// an explained one (an acknowledged baseline carries on). Once the store has
// answered in this process, the process copy is what a read answers from (see
// trendSynced below).
const EMPTY_TREND = Object.freeze({ highWater: null, belowReads: 0, acknowledgedAt: null });
const shapeTrend = (b) => ({
  highWater: b && Number.isFinite(b.highWater) ? b.highWater : null,
  belowReads: b && Number.isInteger(b.belowReads) && b.belowReads >= 0 ? b.belowReads : 0,
  acknowledgedAt: b && typeof b.acknowledgedAt === "string" ? b.acknowledgedAt : null,
});
let memTrend = { ...EMPTY_TREND };
const sameTrend = (a, b) => a.highWater === b.highWater && a.belowReads === b.belowReads && a.acknowledgedAt === b.acknowledgedAt;
export const TREND_STORE_MS = 2_000;
let trendDocument = null;
let skipUpdate = null;
async function trendDoc() {
  if (!trendDocument) {
    const { createJsonDocument } = await import("./json-document.js");
    const file = String(process.env.UPSTREAM_BUYER_TREND_FILE || "").trim() || null;
    trendDocument = createJsonDocument({ name: "upstream-buyer-trend", file, log: () => {}, importFromFile: false });
  }
  if (!skipUpdate) skipUpdate = (await import("./json-document.js")).SKIP_UPDATE;
  return trendDocument;
}
// Whether this process has had one good answer from the store. Until it has,
// the process copy is empty, not the stored mark: a read that used it would
// set a drained balance as the new high-water mark and read "ok" through the
// drain. So the first read waits for the store, and reads "unknown" when it
// does not answer. After that the process copy is the store's, a read answers
// from it at once, and the store takes the same step in the background.
let trendSynced = false;
// Background saves, one after another, each bounded by TREND_STORE_MS so a
// hung store never holds the next one. Bumped on every local step, so a save
// that lands after a newer step does not overwrite the process copy with an
// older state.
let trendSaveChain = Promise.resolve();
let trendStepSeq = 0;
// The store's own log is quiet; a store that does not take the trend is named
// once per process.
let trendStoreWarned = false;
function warnTrendStore(d, why) {
  if (trendStoreWarned) return;
  trendStoreWarned = true;
  try {
    console.warn(`[upstream-buyer] the trend store (${d.backend}) did not take a read (${String(why || "no answer in time").slice(0, 160)}); the trend is held in process memory until it does`);
  } catch { /* logging never throws */ }
}
function queueTrendWrite(d, mutate) {
  const run = () => withinStoreDeadline(d.update(mutate, { fallback: null }));
  const p = trendSaveChain.then(run, run);
  trendSaveChain = p.catch(() => {});
  return p;
}
// One read stepped on the stored body. A read that changes nothing (the same
// mark, the same count) leaves the document alone instead of rewriting it.
function storeStep(d, balance) {
  const out = { word: null };
  const p = queueTrendWrite(d, (b) => {
    const s = shapeTrend(b);
    const o = stepTrend(s, balance);
    out.word = o.word;
    return b != null && sameTrend(s, o.next) ? skipUpdate : o.next;
  });
  return p.then((r) => ({ r, word: out.word }));
}
// A store wait bounded in time: undefined when it did not answer.
async function withinStoreDeadline(p) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), TREND_STORE_MS); timer.unref?.(); });
  try { return await Promise.race([p, deadline]); } catch { return undefined; } finally { clearTimeout(timer); }
}

// One read applied to a trend state: the next state and the word. Pure, so a
// store update that is retried on a conflict applies it to the fresh body.
function stepTrend(state, balance) {
  const s = shapeTrend(state);
  if (s.highWater == null || balance >= s.highWater) {
    // A new high (or the first read) is the healthy case: re-baseline and clear.
    return { next: { ...s, highWater: balance, belowReads: 0 }, word: "ok" };
  }
  if (s.highWater - balance <= BUYER_DROP_TOLERANCE_USD) {
    // Within tolerance: an in-flight call, not a drain. Do NOT reset the
    // counter - a slow bleed sits inside tolerance on every single read.
    return { next: s, word: s.belowReads >= BUYER_DROP_READS ? "draining" : "ok" };
  }
  const below = s.belowReads + 1;
  return { next: { ...s, belowReads: below }, word: below >= BUYER_DROP_READS ? "draining" : "ok" };
}

/** Bucketed trend for the spending wallet: "ok" | "draining". Never a number -
 *  /api/gateway-status is public and balances stay off it. Process memory
 *  only; exported for tests (noteBuyerBalanceStored is the read the status uses). */
export function noteBuyerBalance(balance, { reset = false } = {}) {
  if (reset) memTrend = { ...EMPTY_TREND };
  if (!Number.isFinite(balance)) return "unknown";
  const { next, word } = stepTrend(memTrend, balance);
  memTrend = next;
  return word;
}

/** The same read against the stored trend state (see the note above):
 *  "unknown" while the store has not answered once in this process. */
export async function noteBuyerBalanceStored(balance) {
  if (!Number.isFinite(balance)) return "unknown";
  const d = await trendDoc();
  if (d.backend === "memory") return noteBuyerBalance(balance);
  if (!trendSynced) {
    const { r, word } = await storeStep(d, balance);
    if (r?.ok && word) { trendSynced = true; trendStepSeq++; memTrend = shapeTrend(r.body); return word; }
    warnTrendStore(d, r?.error);
    return "unknown";
  }
  const word = noteBuyerBalance(balance);
  const seq = ++trendStepSeq;
  storeStep(d, balance).then(({ r }) => {
    if (!r?.ok) { warnTrendStore(d, r?.error); return; }
    if (seq === trendStepSeq) memTrend = shapeTrend(r.body);
  });
  return word;
}
/** Resolves once every background trend save queued so far has ended. */
export function flushBuyerTrend() { return trendSaveChain; }

/** An operator's "that fall was mine": re-baseline the high-water mark to the
 *  current balance (or, when it cannot be read now, to the next readable
 *  read), clear the count, and record when. The next status read is fresh and
 *  reads "ok". Resolves { acknowledgedAt, baseline, stored } where stored is
 *  the backend that kept it, or false when the store did not take it (the
 *  process copy is re-baselined either way). Never a balance figure. */
export async function acknowledgeBuyerTrend({ now = Date.now() } = {}) {
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) return { configured: false, status: "unconfigured" };
  const balance = await readBaseBuyerBalance(pk);
  const next = { highWater: Number.isFinite(balance) ? balance : null, belowReads: 0, acknowledgedAt: new Date(now).toISOString() };
  memTrend = { ...next };
  trendStepSeq++;
  trendGeneration++;
  buyerStatusCache = null;
  buyerStatusPending = null;
  const d = await trendDoc();
  let stored = "memory";
  if (d.backend !== "memory") {
    // Queued behind any background save, so an older read cannot land over it.
    const r = await queueTrendWrite(d, () => ({ ...next }));
    stored = r?.ok ? d.backend : false;
    // The store now holds exactly the process copy.
    if (r?.ok) trendSynced = true;
    else warnTrendStore(d, r?.error);
  }
  return { configured: true, acknowledgedAt: next.acknowledgedAt, baseline: next.highWater == null ? "next-read" : "current", stored };
}
export function __resetBuyerTrendForTest() {
  memTrend = { ...EMPTY_TREND }; trendDocument = null; buyerStatusCache = null; buyerStatusPending = null;
  trendSynced = false; trendSaveChain = Promise.resolve(); trendStepSeq = 0; trendStoreWarned = false;
}
/** Test seam: the trend store (an object with `backend` and `update`), or null for the real one. */
export function __setTrendDocumentForTest(doc) { __resetBuyerTrendForTest(); trendDocument = doc; }
const BUYER_LOW_USD = () => Number(process.env.UPSTREAM_BUYER_LOW_USD || String(BUYER_LOW_DEFAULT_USD));
const BUYER_STATUS_CACHE_MS = 5 * 60_000;
let buyerStatusCache = null;
/** Bucketed BALANCE of the Base spending wallet. Nothing more.
 *
 *  Read the name carefully, because it has already misled once: upstream
 *  purchases failed on the paid retry while this reported "ok", and "ok" was
 *  read as "the buying path is healthy". It does not mean that. It means the
 *  wallet holds USDC above a threshold.
 *
 *  It cannot see whether the seller answers, whether the facilitator settles,
 *  whether our payload is accepted, or whether the quote fits the margin cap.
 *  Every one of those fails happily with a full wallet.
 *
 *  Each return carries `attests: "balance-only"` so a consumer cannot mistake
 *  the scope for the name. An alarm wired to this is a FUNDING alarm; proving
 *  that buying works needs a real buy, which is what the paid canary is for. */
export async function upstreamBuyerStatus() {
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) return { configured: false, status: "unconfigured", attests: "balance-only" };
  if (buyerStatusCache && Date.now() - buyerStatusCache.at < BUYER_STATUS_CACHE_MS) return buyerStatusCache.result;
  // One read at a time: two reads at once would each count the same fall.
  if (buyerStatusPending) return buyerStatusPending;
  const p = readBuyerStatus(pk).finally(() => { if (buyerStatusPending === p) buyerStatusPending = null; });
  buyerStatusPending = p;
  return p;
}
let buyerStatusPending = null;
// Bumped by an acknowledgement, so a read that began before it does not
// cache its word over the re-baselined one.
let trendGeneration = 0;
async function readBuyerStatus(pk) {
  const gen = trendGeneration;
  let result;
  try {
    const balance = await readBaseBuyerBalance(pk);
    if (balance != null) noteFundingReading("base", balance, BUYER_LOW_USD());
    result = balance == null
      ? { configured: true, status: "unknown", attests: "balance-only" }
      : { configured: true, status: balance < BUYER_LOW_USD() ? "low" : "ok", attests: "balance-only", trend: await noteBuyerBalanceStored(balance) };
  } catch {
    result = { configured: true, status: "unknown", attests: "balance-only" };
  }
  if (gen === trendGeneration) buyerStatusCache = { at: Date.now(), result };
  return result;
}
// The Base USDC balance of the spending wallet, or null when no RPC answers.
// `__setBuyerBalanceReaderForTest` replaces the RPC read (address -> USD or null).
let balanceReaderForTest = null;
export function __setBuyerBalanceReaderForTest(fn) { balanceReaderForTest = fn; buyerStatusCache = null; }
async function readBaseBuyerBalance(pk) {
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const address = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address;
    if (balanceReaderForTest) { const v = await balanceReaderForTest(address); return Number.isFinite(v) ? v : null; }
    return await baseUsdcBalanceOf(address);
  } catch {
    return null;
  }
}
/** The Base USDC balance of one address, in USD, or null when no RPC answers: a public read, no key. */
export async function baseUsdcBalanceOf(address) {
  try {
    const data = "0x70a08231" + String(address).slice(2).toLowerCase().padStart(64, "0");
    for (const rpc of BASE_RPCS) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
          signal: AbortSignal.timeout(6000),
        });
        const j = await res.json();
        if (typeof j.result === "string" && j.result.startsWith("0x")) return Number(BigInt(j.result === "0x" ? "0x0" : j.result)) / 1e6;
      } catch { /* walk the list */ }
    }
    return null;
  } catch {
    return null;
  }
}

// THE SAME WALLET ON THE OTHER EVM CHAINS (src/evm-buyer-chains.js). One key
// pays on every chain SOR_EVM_CHAINS enables, and each chain holds its own
// balance of that chain's stablecoin, so each one gets its own bucketed
// reading of the same address. Off Base nothing settles back into it (the
// self-funding payTo is a Base rule), so a chain's balance only falls: the
// low-water word is the alarm. UPSTREAM_BUYER_LOW_USD_<CHAIN> sets one chain's
// mark, else UPSTREAM_BUYER_LOW_USD, else the Base default.
const evmChainStatusCache = new Map(); // chain -> { at, result }
const evmChainStatusPending = new Map(); // chain -> the read in flight
// The whole multi-chain read answers within this, whatever the RPCs do: a
// chain still unread then reads "unknown" (its read finishes in the
// background and fills the cache for the next call). /api/gateway-status
// awaits it, and the heartbeat gives that page 15 s.
export const EVM_STATUS_DEADLINE_MS = 5_000;
const lowUsdFor = (chain) => {
  const raw = String(process.env[`UPSTREAM_BUYER_LOW_USD_${String(chain).toUpperCase()}`] ?? "").trim();
  const per = Number(raw);
  return raw !== "" && Number.isFinite(per) && per >= 0 ? per : BUYER_LOW_USD();
};
/** Bucketed balance of the spending wallet on one non-Base EVM buyer chain.
 *  `readBalance` is a test seam (address, cfg, rpc) -> USD or null. */
export async function evmBuyerChainStatus(chain, { readBalance = null, now = Date.now() } = {}) {
  const { evmBuyerChain, evmBuyerRpc } = await import("./evm-buyer-chains.js");
  const cfg = evmBuyerChain(chain);
  if (!cfg || chain === "base") return { configured: false, status: "unconfigured", attests: "balance-only" };
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) return { configured: false, status: "unconfigured", attests: "balance-only" };
  const hit = evmChainStatusCache.get(chain);
  if (hit && now - hit.at < BUYER_STATUS_CACHE_MS) return hit.result;
  // One read per chain at a time: a caller that arrives while a read is out
  // waits on that read instead of sending another.
  const pending = evmChainStatusPending.get(chain);
  if (pending) return pending;
  const p = readEvmChainStatus(chain, cfg, pk, { readBalance, now, evmBuyerRpc })
    .finally(() => { if (evmChainStatusPending.get(chain) === p) evmChainStatusPending.delete(chain); });
  evmChainStatusPending.set(chain, p);
  return p;
}
async function readEvmChainStatus(chain, cfg, pk, { readBalance, now, evmBuyerRpc }) {
  let result;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const address = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address;
    const rpc = evmBuyerRpc(chain);
    let usd = null;
    if (readBalance) usd = await readBalance(address, cfg, rpc);
    else if (rpc) {
      const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: cfg.asset, data }, "latest"] }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await res.json();
      if (typeof j.result === "string" && /^0x[0-9a-f]*$/i.test(j.result)) usd = Number(BigInt(j.result === "0x" ? "0x0" : j.result)) / 10 ** cfg.decimals;
    }
    if (Number.isFinite(usd)) noteFundingReading(`evm:${chain}`, usd, lowUsdFor(chain), { now });
    result = Number.isFinite(usd)
      ? { configured: true, status: usd < lowUsdFor(chain) ? "low" : "ok", attests: "balance-only" }
      : { configured: true, status: "unknown", attests: "balance-only" };
  } catch {
    result = { configured: true, status: "unknown", attests: "balance-only" };
  }
  evmChainStatusCache.set(chain, { at: now, result });
  return result;
}
// First moment the aggregate word read "unknown" (null while readable), so a
// balance that stays unreadable (a dead RPC) pages on its own instead of
// silencing the low-water alarm. Kept in the shared store when one is
// configured, so a deploy (a new process) carries the clock on instead of
// restarting it; in process memory otherwise, or when the store does not
// answer within EVM_UNKNOWN_STORE_MS.
let evmUnknownSince = null;
// Whether this process has cleared the shared mark since it last read
// "unknown" (a readable read clears it once, not on every status read).
let evmUnknownSharedCleared = false;
const EVM_UNKNOWN_KEY = "upstream-buyer:evm-unknown-since";
const EVM_UNKNOWN_TTL_SECONDS = 30 * 24 * 3600;
export const EVM_UNKNOWN_STORE_MS = 500;
async function withStore(fn) {
  let timer;
  try {
    const { getSharedRedisClient } = await import("./shared-limit.js");
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), EVM_UNKNOWN_STORE_MS); timer.unref?.(); });
    return await Promise.race([(async () => { const c = await getSharedRedisClient(); return c ? fn(c) : undefined; })(), deadline]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
async function markEvmUnknown(now) {
  evmUnknownSharedCleared = false;
  if (evmUnknownSince != null) return;
  const shared = await withStore(async (c) => {
    await c.set(EVM_UNKNOWN_KEY, String(now), { NX: true, EX: EVM_UNKNOWN_TTL_SECONDS });
    return Number(await c.get(EVM_UNKNOWN_KEY));
  });
  evmUnknownSince ??= Number.isFinite(shared) && shared > 0 && shared <= now ? shared : now;
}
async function clearEvmUnknown() {
  const had = evmUnknownSince != null;
  evmUnknownSince = null;
  if (!had && evmUnknownSharedCleared) return;
  evmUnknownSharedCleared = true;
  await withStore((c) => c.del(EVM_UNKNOWN_KEY));
}
/** One word for every enabled non-Base EVM buyer chain, and one per chain:
 *  "off" when none is enabled, else "low" when any chain reads low, "unknown"
 *  when any is unreadable, otherwise "ok" (or "unconfigured" with no key).
 *  While "unknown", unknownForMinutes says for how long. Words only otherwise:
 *  no balance, no address, no threshold. */
export async function upstreamBuyerEvmStatus({ deadlineMs = EVM_STATUS_DEADLINE_MS, ...opts } = {}) {
  const { enabledEvmBuyerChains } = await import("./evm-buyer-chains.js");
  const chains = enabledEvmBuyerChains().filter((c) => c !== "base");
  if (!chains.length) { await clearEvmUnknown(); return { status: "off" }; }
  const UNREAD = { configured: true, status: "unknown", attests: "balance-only" };
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(UNREAD), deadlineMs); timer.unref?.(); });
  // Every chain at once, each raced against the one shared deadline.
  const reads = await Promise.all(chains.map((c) => Promise.race([evmBuyerChainStatus(c, opts).catch(() => UNREAD), deadline])));
  clearTimeout(timer);
  const out = {};
  chains.forEach((c, i) => {
    const r = reads[i] || UNREAD;
    out[c] = { configured: r.configured, status: r.status, attests: r.attests };
  });
  const words = Object.values(out).map((r) => r.status);
  const status = words.includes("low") ? "low" : words.includes("unknown") ? "unknown" : words.every((w) => w === "unconfigured") ? "unconfigured" : "ok";
  const now = opts.now ?? Date.now();
  if (status === "unknown") await markEvmUnknown(now); else await clearEvmUnknown();
  return { status, chains: out, ...(evmUnknownSince != null ? { unknownForMinutes: Math.floor((now - evmUnknownSince) / 60_000) } : {}) };
}
export function __resetEvmChainStatusForTest() { evmChainStatusCache.clear(); evmChainStatusPending.clear(); evmUnknownSince = null; evmUnknownSharedCleared = false; }
