// Paying wallets resolved to the operator behind them, where public evidence
// says so, for the operator scoreboard (counts only; never published).
//
// A wallet maps to an operator only on positive, checkable evidence, each
// mapping carrying its provenance { operator, source, evidence, checkedAt }:
//   payTo     the wallet is the receiving address ONE indexed origin
//             advertises in its own 402 (src/x402-index.js payTo scan); the
//             operator is that origin's host. An address two or more origins
//             advertise (a shared platform wallet) maps to nothing.
//   ens       the wallet's ENS primary name on Ethereum, read through the
//             universal resolver and checked forward: the name's address
//             record must be the same wallet
//   basename  the wallet's primary name on Base (the reverse record under
//             80002105.reverse on Base's L2 resolver), checked forward the
//             same way, and only a *.base.eth name
// Nothing else: no timing, price, cadence or funding pattern ever groups two
// wallets, so an unresolved wallet counts as an operator of its own and the
// operator count is an upper bound. Two wallets share an operator only when
// they resolve to the identical operator key.
//
// Lookups run a few at a time under a per-lookup limit; the answer waits up
// to a deadline and reports what is still pending, and the rest land in the
// cache for the next read. The cache is in memory, bounded in entries and age
// (a miss is retried sooner than a hit).
import { createPublicClient, http, fallback, namehash, getAddress, isAddress } from "viem";
import { mainnet, base } from "viem/chains";
import { normalize } from "viem/ens";

// A wallet is looked up at most once per OPERATOR_CACHE_TTL_MS when it has a
// name and once per OPERATOR_MISS_TTL_MS when it has none, OPERATOR_LOOKUP_CONCURRENCY
// at a time, and only when the operator reads the scoreboard (itself cached).
export const OPERATOR_CACHE_TTL_MS = 7 * 86_400_000;
export const OPERATOR_MISS_TTL_MS = 86_400_000;
export const OPERATOR_LOOKUP_CONCURRENCY = 4;
export const OPERATOR_SOURCES = Object.freeze(["payTo", "ens", "basename"]);
export const BASE_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
const BASE_REVERSE_SUFFIX = "80002105.reverse"; // ENSIP-11 coin type of Base (0x80000000 | 8453)
const L2_RESOLVER_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "string" }] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
];
const HEX = /^0x[0-9a-fA-F]{40}$/;
const NAME_RE = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,5}$/;

/** A name accepted as an operator key: normalized, plain ASCII labels, at most six. */
function cleanName(name) {
  if (typeof name !== "string" || !name) return null;
  let n;
  try { n = normalize(name); } catch { return null; }
  return n === name && NAME_RE.test(n) ? n : null;
}

const rpcList = (alchemyHost, publics) => [
  ...(process.env.ALCHEMY_API_KEY ? [`https://${alchemyHost}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
  ...publics,
];
const clientFor = (chain, urls, timeoutMs) => createPublicClient({
  chain, ccipRead: false,
  transport: fallback(urls.map((u) => http(u, { timeout: timeoutMs, retryCount: 0 }))),
});

/** The default chain lookups: ENS primary name on Ethereum and Basename on Base, each forward-checked. */
export function defaultNameLookups({ timeoutMs = 5000, clients = null } = {}) {
  // `clients` ({ eth, base }: anything with viem's getEnsName, getEnsAddress
  // and readContract) is for tests; production builds its own on first use.
  let eth = clients?.eth || null, baseClient = clients?.base || null;
  const ethC = () => eth || (eth = clientFor(mainnet, rpcList("eth-mainnet", ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]), timeoutMs));
  const baseC = () => baseClient || (baseClient = clientFor(base, rpcList("base-mainnet", ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]), timeoutMs));
  return {
    async ens(address) {
      const c = ethC();
      const name = cleanName(await c.getEnsName({ address: getAddress(address) }));
      if (!name) return null;
      const fwd = await c.getEnsAddress({ name });
      return fwd && fwd.toLowerCase() === address.toLowerCase() ? name : null;
    },
    async basename(address) {
      const c = baseC();
      const node = namehash(`${address.toLowerCase().slice(2)}.${BASE_REVERSE_SUFFIX}`);
      const name = cleanName(await c.readContract({ address: BASE_L2_RESOLVER, abi: L2_RESOLVER_ABI, functionName: "name", args: [node] }));
      if (!name || !name.endsWith(".base.eth")) return null;
      const fwd = await c.readContract({ address: BASE_L2_RESOLVER, abi: L2_RESOLVER_ABI, functionName: "addr", args: [namehash(name)] });
      return fwd && fwd.toLowerCase() === address.toLowerCase() ? name : null;
    },
  };
}

/** The host of the one origin advertising `address` as its payTo, or null. */
export function payToOperatorOf(address, payToOrigins, shared = null) {
  const k = String(address || "").toLowerCase();
  if (!payToOrigins || typeof payToOrigins.get !== "function") return null;
  if (shared && typeof shared.has === "function" && shared.has(k)) return null;
  const origins = payToOrigins.get(k);
  const list = origins ? [...origins] : [];
  if (list.length !== 1) return null;
  try { return { host: new URL(list[0]).host.toLowerCase(), origin: list[0] }; } catch { return null; }
}

/**
 * @param {object} o
 * @param {object} [o.lookups]   { ens(addr), basename(addr) } async, forward-checked (defaultNameLookups())
 * @param {function} [o.payTo]   (addr) => { host, origin } | null, synchronous
 */
export function createOperatorResolver({
  lookups = null, payTo = () => null, now = Date.now,
  ttlMs = OPERATOR_CACHE_TTL_MS, missTtlMs = OPERATOR_MISS_TTL_MS, cap = 20_000, concurrency = OPERATOR_LOOKUP_CONCURRENCY, perLookupMs = 8000,
} = {}) {
  const names = lookups || defaultNameLookups();
  const cache = new Map(); // lowercased address -> { mapping|null, at, failed }
  const inflight = new Map(); // address -> Promise
  const queue = [];
  let running = 0;
  const fresh = (e) => e && now() - e.at < (e.mapping ? ttlMs : missTtlMs);
  const put = (k, entry) => {
    cache.delete(k); cache.set(k, entry);
    while (cache.size > cap) cache.delete(cache.keys().next().value);
  };
  const within = (p) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("lookup timed out")), perLookupMs); })]).finally(() => clearTimeout(t));
  };

  async function lookup(k) {
    const at = now();
    let failed = false;
    for (const source of ["ens", "basename"]) {
      if (typeof names[source] !== "function") continue;
      try {
        const name = await within(names[source](k));
        if (name) return { mapping: { operator: name, source, evidence: `${source === "ens" ? "ENS primary name on Ethereum" : "primary name on Base"} ${name}; its address record is this wallet`, checkedAt: new Date(at).toISOString() }, at, failed: false };
      } catch { failed = true; }
    }
    return { mapping: null, at, failed };
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const { k, resolve } = queue.shift();
      running++;
      lookup(k).then((entry) => {
        // A lookup that could not be read is retried on the next read, never cached as "no name".
        if (!entry.failed || entry.mapping) put(k, entry);
        resolve(entry);
      }, () => resolve({ mapping: null, failed: true })).finally(() => { running--; inflight.delete(k); pump(); });
    }
  }
  function start(k) {
    if (inflight.has(k)) return inflight.get(k);
    const p = new Promise((resolve) => { queue.push({ k, resolve }); });
    inflight.set(k, p);
    pump();
    return p;
  }

  /** The mapping for each address (registry first, then cached or fresh name lookups), waiting at most deadlineMs. */
  async function resolveAll(addresses, { deadlineMs = 10_000 } = {}) {
    const out = new Map();
    const waits = [];
    for (const raw of addresses || []) {
      const k = String(raw || "").toLowerCase();
      if (!HEX.test(k) || !isAddress(k, { strict: false })) { out.set(k, { kind: "non-evm" }); continue; }
      const reg = payTo(k);
      if (reg) {
        out.set(k, { mapping: { operator: reg.host, source: "payTo", evidence: `advertised as the payTo of ${reg.origin} in its own 402`, checkedAt: new Date(now()).toISOString() } });
        continue;
      }
      const c = cache.get(k);
      if (fresh(c)) { out.set(k, { mapping: c.mapping }); continue; }
      out.set(k, { pending: true });
      waits.push(start(k).then((e) => { out.set(k, e.failed && !e.mapping ? { unreadable: true } : { mapping: e.mapping }); }));
    }
    if (waits.length) {
      let timer;
      await Promise.race([Promise.all(waits), new Promise((r) => { timer = setTimeout(r, deadlineMs); })]);
      clearTimeout(timer);
    }
    return out;
  }

  /** Counts only: wallets, operators (upper bound), resolved wallets by source, unresolved, non-EVM, pending. */
  async function operatorsOf(addresses, opts = {}) {
    const res = await resolveAll(addresses, opts);
    const operators = new Set();
    const bySource = Object.fromEntries(OPERATOR_SOURCES.map((s) => [s, 0]));
    let resolved = 0, unresolved = 0, nonEvm = 0, pending = 0, unreadable = 0;
    for (const [k, r] of res) {
      if (r.mapping) { resolved++; bySource[r.mapping.source]++; operators.add(`op:${r.mapping.operator}`); continue; }
      operators.add(`wallet:${k}`);
      if (r.kind === "non-evm") nonEvm++;
      else if (r.pending) pending++;
      else if (r.unreadable) unreadable++;
      else unresolved++;
    }
    return {
      wallets: res.size, operators: operators.size, resolvedWallets: resolved, bySource,
      unresolvedWallets: unresolved, nonEvmWallets: nonEvm, pendingWallets: pending, unreadableWallets: unreadable,
      upperBound: true,
    };
  }
  return { resolveAll, operatorsOf, size: () => cache.size, _cache: cache };
}
