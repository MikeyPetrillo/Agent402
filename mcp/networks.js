// Network preference for the x402 buyer, pure helpers, no side effects.
//
// AGENT402_NETWORKS (comma-separated, e.g. "robinhood" or "base,solana" or a
// raw CAIP-2 like "eip155:4663") restricts AND orders which payment options
// the buyer will consider from a seller's 402 `accepts`. Without it the
// underlying @x402 client picks whichever registered scheme matches first,
// which on a multi-chain seller is effectively always Base, making rails like
// USDG on Robinhood Chain unreachable no matter what the wallet holds.
import tls from "node:tls";
import { createHash, X509Certificate } from "node:crypto";

export const NETWORK_CAIP2 = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
  robinhood: "eip155:4663",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

/** Parse "robinhood,base" / "eip155:4663" into an ordered CAIP-2 list.
 *  Unknown names pass through verbatim so raw CAIP-2 ids (future chains)
 *  work without a package update. Returns [] when unset. */
export function parseNetworkPrefs(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => NETWORK_CAIP2[n] || n);
}

/** Filter a 402's accepts to the preferred networks, ordered by preference
 *  (all accepts for the 1st preferred chain, then the 2nd, …). Throws with an
 *  actionable message when nothing matches, better than silently paying on a
 *  chain the operator excluded. No prefs → accepts unchanged. */
export function filterAcceptsByNetworks(accepts, prefs) {
  if (!prefs?.length) return accepts;
  const list = Array.isArray(accepts) ? accepts : [];
  const picked = prefs.flatMap((caip2) => list.filter((a) => String(a?.network || "").toLowerCase() === caip2.toLowerCase()));
  if (!picked.length) {
    const offered = [...new Set(list.map((a) => a?.network).filter(Boolean))];
    throw new Error(
      `AGENT402_NETWORKS matched none of the seller's payment options: wanted [${prefs.join(", ")}], offered [${offered.join(", ")}]. ` +
        "Remove the restriction or add one of the offered networks."
    );
  }
  return picked;
}

/** Apply the preference to an @x402 client (duck-typed, any version with
 *  createPaymentPayload works): the client only ever sees the filtered,
 *  preference-ordered accepts. Returns the same client for chaining. */
export function withNetworkPreference(client, prefs) {
  if (!prefs?.length) return client;
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (paymentRequired) =>
    orig({ ...paymentRequired, accepts: filterAcceptsByNetworks(paymentRequired?.accepts, prefs) });
  return client;
}

// ---------------------------------------------------------------------------
// Transport: refuse TLS chains through a distrusted intermediate CA, for this
// server's own requests (a dedicated dispatcher, nothing global).
//
// The private keys of the intermediate CAs below are recoverable (Mozilla bug
// 2083449). A cross-signed path makes them validate against "emSign ECC Root
// CA - G3" in Node's bundled store, and Node checks no revocation by default,
// so a certificate minted with one of these keys for a seller's host would be
// accepted, and a forged 402 could name a different payTo. Keyed on the
// SubjectPublicKeyInfo sha256 of every certificate in the presented chain.
// The same code as agent402-client's tls-distrust.js (the parent repo's
// scripts/test-tls-distrust.js holds the copies equal); it lives in this file
// because the images copy an explicit file list. It applies only when the
// platform fetch is Node's and the process-wide dispatcher is a plain Agent
// (a proxy or custom dispatcher is left in charge). It can be removed once the
// Node releases this package supports ship a CA store that no longer builds
// the path.
export const DISTRUSTED_SPKI_SHA256 = Object.freeze({
  "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105": "EM DV TLS CA - G3B",
  "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b": "EM OV TLS CA - G3B",
  "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41": "EM EV TLS CA - G3B",
  "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f": "EM DV TLS CA - G3C",
  "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8": "EM OV TLS CA - G3C",
  "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0": "EM EV TLS CA - G3C",
  "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6": "EM OV CS CA - G3B",
  "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30": "EM OV CS CA - G3C",
});

/** checkServerIdentity that refuses a chain through a listed key (plus any
 *  `extraSpki` hex hashes), else defers to Node's hostname check. */
export function distrustCheckServerIdentity(extraSpki = []) {
  const extra = new Set([...extraSpki].map((h) => String(h).toLowerCase()));
  const nodeCheck = tls.checkServerIdentity;
  return (host, cert) => {
    const seen = [];
    for (let c = cert; c && typeof c === "object" && !seen.includes(c) && seen.length < 16; c = c.issuerCertificate === c ? null : c.issuerCertificate) {
      seen.push(c);
      if (!c.raw) continue;
      let spki;
      try {
        spki = createHash("sha256").update(new X509Certificate(c.raw).publicKey.export({ type: "spki", format: "der" })).digest("hex");
      } catch {
        return Object.assign(new Error(`Refusing the TLS certificate for ${host}: distrusted intermediate check could not read the certificate chain`), { code: "ERR_TLS_DISTRUSTED_INTERMEDIATE" });
      }
      const name = DISTRUSTED_SPKI_SHA256[spki] || (extra.has(spki) ? "listed key" : null);
      if (name) return Object.assign(new Error(`Refusing the TLS certificate for ${host}: distrusted intermediate (${name}) in the certificate chain`), { code: "ERR_TLS_DISTRUSTED_INTERMEDIATE" });
    }
    return nodeCheck(host, cert);
  };
}

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/** A dedicated undici Agent carrying the refusal, or null when this platform
 *  or process setup cannot take one (see the header). */
export async function distrustDispatcher({ extraSpki = [] } = {}) {
  if (typeof process !== "object" || !process?.versions?.node || process.versions.bun) return null;
  if (!globalThis[GLOBAL_DISPATCHER] && typeof globalThis.fetch === "function") {
    // Node creates its default Agent on the first fetch; a data: URL makes no
    // connection.
    try { await globalThis.fetch("data:,"); } catch { /* not Node's fetch */ }
  }
  const current = globalThis[GLOBAL_DISPATCHER];
  const AgentClass = current?.constructor;
  if (typeof AgentClass !== "function" || AgentClass.name !== "Agent") return null;
  return new AgentClass({ connect: { checkServerIdentity: distrustCheckServerIdentity(extraSpki) } });
}

/** Wrap a fetch so every request it makes goes through distrustDispatcher().
 *  With no baseFetch it calls globalThis.fetch as it is at request time. A
 *  caller's own init.dispatcher is left alone. Pass the result as the base
 *  fetch of a payment wrapper (wrapFetchWithPayment(distrustFetch(), client))
 *  so the 402 and the paid retry both go through it. */
export function distrustFetch(baseFetch, opts = {}) {
  if (baseFetch !== undefined && typeof baseFetch !== "function") throw new Error("distrustFetch needs a fetch function");
  let pending = null;
  return async (input, init = {}) => {
    const f = baseFetch || globalThis.fetch;
    pending ||= distrustDispatcher(opts).catch(() => null);
    const dispatcher = await pending;
    return f(input, dispatcher && init?.dispatcher === undefined ? { ...init, dispatcher } : init);
  };
}
