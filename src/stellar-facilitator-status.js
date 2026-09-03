// Low-water alarm for the Stellar facilitator's fee-paying account.
//
// Every other spending wallet we run has one (upstreamBuyer, upstreamBuyerAvm,
// upstreamBuyerTempo, subscriptionFeePayer, the canary burners). This one did
// not, and it is the account that pays the transaction fee on EVERY Stellar
// settlement: measured 2026-08-31 it held 5.906 XLM with nothing watching it.
//
// Settlements are CHEAP, so this is a slow alarm, not an urgent one: the
// observed fee_charged is 23,501 stroops = 0.00235 XLM (about $0.0007), so
// 5.906 XLM is roughly 2,500 settlements, or ~800 even if every one of them
// paid the raised inclusion bid in full. The point of the alarm is that an
// empty fee account does not look like an outage - settlements simply stop
// landing and the canary reports a rail failure - not that it is close to
// empty. Size FACILITATOR_LOW_BALANCE_XLM to give real lead time rather than
// to fire early; a threshold that pages with thousands of settlements left is
// an alarm nobody reads.
//
// The facilitator already computes this - GET /health returns signerAddress,
// xlmBalance and a `low` flag against its own FACILITATOR_LOW_BALANCE_XLM
// (default 5). Nothing polled it. So this is a bucketed relay of that answer
// onto /api/gateway-status, where the heartbeat already reads every other
// wallet alarm, rather than a second implementation of the same read.
//
// Bucketed, never the number: /api/gateway-status is a PUBLIC surface and the
// same rule applies here as to every other balance on it.
//
// "unknown" is never "ok". A facilitator we cannot read is a facilitator whose
// balance we do not know, and reporting that as healthy is how a low balance
// reaches an empty one unannounced.

const HEALTH_TIMEOUT_MS = Number(process.env.STELLAR_FACILITATOR_STATUS_TIMEOUT_MS) || 4000;

/** Shape check before trusting a /health body. STELLAR_FACILITATOR_URL may
 *  point at a third party (it defaults to one), and a stranger's /health is
 *  not this alarm's subject - answering "ok" off an unrelated 200 would be a
 *  fabricated all-clear. Only our own facilitator publishes this trio. */
export function readsAsOurFacilitator(body) {
  return !!body
    && typeof body === "object"
    && typeof body.signerAddress === "string"
    && body.signerAddress.startsWith("G")
    && ("xlmBalance" in body)
    && ("low" in body);
}

export async function stellarFacilitatorStatus({ fetchImpl = fetch } = {}) {
  const url = (process.env.STELLAR_FACILITATOR_URL || "").trim().replace(/\/+$/, "");
  if (!url) return { status: "unconfigured", asset: "XLM", chain: "stellar:pubnet" };

  const out = (status) => ({ status, asset: "XLM", chain: "stellar:pubnet" });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    let body;
    try {
      const res = await fetchImpl(`${url}/health`, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) return out("unknown");
      body = await res.json();
    } finally { clearTimeout(t); }

    if (!readsAsOurFacilitator(body)) return out("unknown");
    // The facilitator reports low:null when Horizon itself was unreadable.
    // That is an unknown balance, not a healthy one.
    if (body.low === true) return out("low");
    if (body.low === false) return out("ok");
    return out("unknown");
  } catch {
    return out("unknown");
  }
}
