// WWW-Authenticate projection for the 402 size guards
// (scripts/test-challenge-size.js, scripts/test-challenge-fit.js).
//
// A 402's WWW-Authenticate holds one `Payment` challenge per MPP method: the
// evm challenges (src/mpp-shim.js, built from THIS tree's PAYMENT-REQUIRED)
// and the Tempo ones (src/mpp-tempo.js, keyed on a deployment secret a local
// boot does not hold). So a projection of production's 402 with this tree's
// code takes each evm challenge from the local boot, chain by chain, and keeps
// production's challenge for every chain and method the local boot does not
// issue. The local realm is rewritten to production's so the host name does
// not count against either side.

/** Split a WWW-Authenticate value into its `Payment ...` challenges, honoring quotes. */
export function splitChallenges(header) {
  const s = String(header || "");
  const out = [];
  let start = 0, inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && inQuote) { i++; continue; }
    if (c === "\"") { inQuote = !inQuote; continue; }
    if (!inQuote && c === "," && /^,\s*Payment\s/i.test(s.slice(i, i + 12))) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

const param = (challenge, name) => {
  const m = new RegExp(`(?:^Payment\\s+|,\\s*)${name}="([^"]*)"`, "i").exec(challenge);
  return m ? m[1] : null;
};

/** The chain id of an evm/charge challenge, or null for any other method. */
export function evmChainOf(challenge) {
  if (param(challenge, "method") !== "evm") return null;
  try {
    const req = JSON.parse(Buffer.from(param(challenge, "request") || "", "base64url").toString("utf8"));
    const id = Number(req?.methodDetails?.chainId);
    return Number.isInteger(id) ? id : null;
  } catch { return null; }
}

/** Production's WWW-Authenticate with each evm challenge the local boot issues
 *  swapped for the local one (realm rewritten to production's). */
export function mergeEvmChallenges(prodHeader, localHeader) {
  const prod = splitChallenges(prodHeader);
  const prodRealm = prod.map((c) => param(c, "realm")).find((r) => r != null);
  const local = new Map();
  for (const c of splitChallenges(localHeader)) {
    const id = evmChainOf(c);
    if (id == null) continue;
    const realm = param(c, "realm");
    local.set(id, prodRealm != null && realm != null ? c.replace(`realm="${realm}"`, `realm="${prodRealm}"`) : c);
  }
  // MPP on or off is the deployment's switch: no challenge on production, none projected.
  if (!prod.length) return "";
  return prod.map((c) => { const id = evmChainOf(c); return id != null && local.has(id) ? local.get(id) : c; }).join(", ");
}
