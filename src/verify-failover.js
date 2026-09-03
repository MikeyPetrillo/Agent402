// Verify falls over to another facilitator when the first one cannot be REACHED.
//
// Measured 2026-08-30: seven Solana payments failed with
// `[CDP (Base)] fetch failed [UND_ERR_CONNECT_TIMEOUT]`, and one buyer's three
// attempts inside 30 seconds produced no settlement at all - the purchase was
// simply lost. CDP was reachable from everywhere else at the time (15-37 ms), so
// this is our egress or a momentary black hole, not a Coinbase outage.
//
// Why nothing recovered it, from @x402/core's own dispatcher:
//
//     const client = this.getFacilitatorClient(version, network, scheme);
//     if (!client) { for (const c of this.facilitatorClients) { try { ...; break } catch {} } }
//     else         { verifyResult = await client.verify(payload, requirements); }
//
// The loop over every client runs ONLY when no client is resolved. CDP does
// advertise Solana, so it resolves, and its transport failure is fatal - PayAI,
// the facilitator our own boot log calls Solana's owner, is never asked.
//
// The same dispatcher honours a recovery from the failure hook:
//
//     if (result && "recovered" in result && result.recovered) return runAfterVerifyHooks(result.result, ...)
//
// so the fix belongs there rather than in a fork of the vendor.
//
// WHY THIS IS SAFE, and why the same thing must never be done for settle:
// verify is a READ. It asks whether a signed authorization is good; it moves no
// money and has no side effect, so asking a second facilitator cannot double
// charge anyone. settle is a WRITE and is deliberately left alone.
//
// The bright line, same as the facilitator RPC failover: only a failure to be
// REACHED is retried. A facilitator that ANSWERS - "invalid signature",
// "insufficient funds", any verdict at all - has done its job, and asking a
// second one until somebody says yes would be shopping for a permissive
// answer on a payment. That is the one thing this must never do.

/** A transport failure: we never got a verdict. Retryable. */
export function isUnreachable(err) {
  if (!err) return false;
  const msg = String(err?.message || err);
  const code = String(err?.code || err?.cause?.code || "");
  if (/UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(`${msg} ${code}`)) return true;
  if (/fetch failed|network error|request timed?[- ]out|aborted/i.test(msg)) return true;
  // A 5xx is the facilitator failing to answer for itself; 4xx is an answer.
  if (/\b(50\d|429)\b/.test(msg) && /facilitator|verify|http/i.test(msg)) return true;
  return false;
}

/** An answer, however unwelcome. NEVER retried - see the bright line above. */
export function isVerdict(err) {
  if (!err) return false;
  const msg = String(err?.message || err);
  return /invalid_|insufficient|expired|unsupported|malformed|signature|payload|not_?found|forbidden|unauthorized|\b40\d\b/i.test(msg)
    && !isUnreachable(err);
}

/**
 * Try the OTHER facilitators that advertise this network, once each, in order.
 *
 * @param {object}   p
 * @param {Error}    p.error        - what the first facilitator threw
 * @param {object}   p.paymentPayload
 * @param {object}   p.requirements
 * @param {Array<{label:string, client:object}>} p.registry - all configured clients
 * @param {(label:string, msg:string)=>void} [p.log]
 * @returns {Promise<{recovered:true, result:object, via:string}|null>}
 */
export async function verifyElsewhere({ error, paymentPayload, requirements, registry, log = () => {} }) {
  if (!isUnreachable(error) || isVerdict(error)) return null;
  const network = requirements?.network;
  const scheme = requirements?.scheme;
  if (!network || !Array.isArray(registry) || registry.length < 2) return null;

  for (const { label, client } of registry) {
    if (typeof client?.verify !== "function") continue;
    // Only ask a facilitator that says it can settle this network+scheme, so a
    // fallback never turns a reachability problem into a wrong-rail answer.
    try {
      const supported = typeof client.getSupported === "function" ? await client.getSupported() : null;
      if (supported) {
        const kinds = supported.kinds || supported;
        const ok = Array.isArray(kinds) && kinds.some((k) => k?.network === network && (!scheme || k?.scheme === scheme));
        if (!ok) continue;
      }
    } catch { continue; } // cannot say what it supports -> do not guess
    try {
      const result = await client.verify(paymentPayload, requirements);
      log(label, `verify recovered on ${network} via ${label} after the first facilitator was unreachable`);
      return { recovered: true, result, via: label };
    } catch (e) {
      // A second unreachable client: keep going. A VERDICT from the fallback is
      // a real answer about this payment - stop and let it stand rather than
      // hunting for a facilitator that approves it.
      if (!isUnreachable(e)) return null;
    }
  }
  return null;
}
