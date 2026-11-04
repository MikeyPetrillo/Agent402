// OUR OWN WALLETS ARE NEVER A SELLER. A listing that fronts this host (a
// www or platform twin, or an outside name pointed at it) carries our own
// payTo, and the router would then pay our treasury from a spending wallet:
// a self-payment booked as a purchase. Every address we receive or spend on
// is refused before anything is signed: the per-rail payTo and spending
// addresses from the environment, and every internal wallet revenue-live.js
// already holds apart from revenue (treasury, spending wallets, burners,
// test buyers). EVM addresses compare lowercased; base58, Stellar and
// Algorand addresses compare exactly as written. route-execute skips such a
// candidate, and each buyer refuses it again right before it signs, since a
// seller with no proven payTo is only known by its live challenge.
const OWN_ADDRESS_ENV = ["WALLET_ADDRESS", "TEMPO_RECIPIENT_ADDRESS", "X402_UPSTREAM_BUYER_ADDRESS", "SOLANA_WALLET_ADDRESS", "STELLAR_WALLET_ADDRESS", "ALGORAND_WALLET_ADDRESS", "ALGORAND_UPSTREAM_BUYER_ADDRESS"];
// The internal wallet sets fail closed: when revenue-live.js cannot be
// loaded, no address is cleared as "not ours" (isOwnPayoutAddress answers
// true for every address, so route-execute skips every candidate, and each
// buyer refuses with a 503 before signing). A failed load is not cached, so
// the next call tries again.
const importRevenueLive = () => import("./revenue-live.js");
let importWalletModule = importRevenueLive;
let ownWalletSets = null;
async function loadOwnWalletSets() {
  if (!ownWalletSets) {
    // Loaded on first use: revenue-live.js is a large module, and this file
    // is imported by the buyers, the index and the router worker.
    try {
      const m = await importWalletModule();
      const evm = m.OUR_EVM_WALLETS;
      const other = [m.OUR_SOLANA_WALLETS, m.OUR_STELLAR_WALLETS, m.OUR_ALGORAND_WALLETS];
      if (!(evm instanceof Set) || !other.every((s) => s instanceof Set)) return null;
      ownWalletSets = { evm, other };
    } catch { return null; }
  }
  return ownWalletSets;
}
/** Test seam: replace the module the wallet sets load from (null restores it); clears the cache. */
export function setOwnWalletImportForTest(fn) {
  importWalletModule = fn || importRevenueLive;
  ownWalletSets = null;
}
/** Is `addr` one of our own wallets? `sets` is injectable for tests. True for
 *  every address while the internal wallet list cannot be loaded. */
export async function isOwnPayoutAddress(addr, { sets = null, env = process.env } = {}) {
  const a = typeof addr === "string" ? addr.trim() : "";
  if (!a) return false;
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(a);
  for (const k of OWN_ADDRESS_ENV) {
    const v = String(env[k] || "").trim();
    if (v && (isEvm ? v.toLowerCase() === a.toLowerCase() : v === a)) return true;
  }
  const s = sets || await loadOwnWalletSets();
  if (!s) return true;
  if (isEvm) return s.evm.has(a.toLowerCase());
  return s.other.some((set) => set.has(a));
}
/** Throws a 502 (nothing signed) when `addr` is one of our own wallets, and a
 *  503 (nothing signed) when the internal wallet list cannot be loaded. */
export async function assertNotOwnPayout(addr) {
  if (!(await loadOwnWalletSets())) {
    throw Object.assign(new Error("own-wallet list unavailable; nothing was signed"), { statusCode: 503, retryAfter: 30 });
  }
  if (await isOwnPayoutAddress(addr)) {
    throw Object.assign(new Error("Refusing to pay one of this server's own wallets. Nothing was signed."), { statusCode: 502 });
  }
}
