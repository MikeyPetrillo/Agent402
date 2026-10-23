// Robinhood Chain (eip155:4663) settle order, by the listed facilitator's gas.
//
// The listed facilitator settles first, and our own relayer
// (src/robinhood-relayer.js) is the fallback after a refusal that moved no
// money. While the facilitator's settlement signer cannot pay for settlements,
// every payment would wait for its refusal first. The gas check
// (src/facilitator-gas.js) already reads that signer's balance and runway on
// a leased schedule, shared across containers through the failure monitor's
// snapshots; this module turns those readings into the order:
//
//   - every READ row for the facilitator (status ok or low, a runway) is
//     below ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS (default 50): our relayer
//     settles first and the facilitator is not asked for that payment;
//   - a later reading above the threshold puts the facilitator first again;
//   - no fresh read row (unread, unknown, stale, never read): the facilitator
//     stays first. A missing reading never moves the order.
//
// The skip is per payment and changes nothing else: verification, the 402,
// claims and the late-settlement book run exactly as they do when the
// facilitator is asked first. The settle-failure hook reads
// ownFirstAttemptOf() so our relayer is not asked twice and its own ambiguous
// answer is not handed back to it.

export const ROBINHOOD_ORDER_NETWORK = "eip155:4663";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export function skipDryThreshold(env = process.env) {
  return num(String(env.ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS ?? "").trim() || NaN, 50);
}
export function readingFreshMs(env = process.env) {
  return num(env.FACILITATOR_GAS_FRESH_MS, 45 * 60_000);
}

const atOf = (r) => (typeof r?.at === "number" ? r.at : Date.parse(String(r?.at || "")) || 0);

/**
 * True when every fresh, read gas row of `host` on `network` is below
 * `threshold` settlements of runway. No such row: false.
 */
export function facilitatorIsDry(readings, { host, network = ROBINHOOD_ORDER_NETWORK, threshold = skipDryThreshold(), freshMs = readingFreshMs(), now = Date.now() } = {}) {
  if (!host) return false;
  const rows = (Array.isArray(readings) ? readings : []).filter((r) =>
    r && !r.own && r.network === network && r.facilitator === host
    && (r.status === "ok" || r.status === "low")
    && Number.isFinite(r.runway) && now - atOf(r) <= freshMs);
  if (!rows.length) return false;
  return rows.every((r) => r.runway < threshold);
}

/**
 * The order state for one facilitator host. `update(readings)` re-decides it
 * and logs one line when the order changes; `ownFirst()` is read per settle.
 */
export function createRobinhoodOrder({ host, network = ROBINHOOD_ORDER_NETWORK, threshold = skipDryThreshold(), freshMs = readingFreshMs(), now = Date.now, log = console.warn } = {}) {
  const state = { ownFirst: false, since: null, checkedAt: null };
  return {
    host,
    update(readings) {
      const t = now();
      state.checkedAt = t;
      const dry = facilitatorIsDry(readings, { host, network, threshold, freshMs, now: t });
      if (dry === state.ownFirst) return false;
      state.ownFirst = dry;
      state.since = t;
      try {
        log(dry
          ? `Robinhood: ${host} dry, own relayer first`
          : `Robinhood: ${host} funded again, facilitator first`);
      } catch { /* logging only */ }
      return true;
    },
    ownFirst() { return state.ownFirst; },
    view() {
      return {
        network, facilitator: host, threshold,
        first: state.ownFirst ? "own relayer" : host,
        since: state.since ? new Date(state.since).toISOString() : null,
        checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
      };
    },
  };
}

// paymentPayload -> network: payments our relayer settled first because the
// facilitator was dry. The payload is decoded per request, so the note lives
// exactly as long as it.
const ownFirstAttempts = new WeakMap();

/** True when this payload was handed to our relayer first on `network`. */
export function ownFirstAttemptOf(paymentPayload, network) {
  return !!paymentPayload && typeof paymentPayload === "object" && ownFirstAttempts.get(paymentPayload) === network;
}

/**
 * Wrap the listed facilitator client's settle: on `network`, while
 * `order.ownFirst()`, the payment goes to `relayer.settle` and the facilitator
 * is not asked. Everything else (other networks, the facilitator funded or
 * unread) calls the facilitator as before.
 */
export function withRobinhoodGasOrder(client, { order, relayer, network = ROBINHOOD_ORDER_NETWORK } = {}) {
  if (!client || typeof client.settle !== "function" || client.settle.__a402GasOrder) return client;
  if (!order || !relayer || typeof relayer.settle !== "function") return client;
  const orig = client.settle;
  const settle = async function gasOrderedSettle(payload, requirements, ...rest) {
    if (requirements?.network !== network || !order.ownFirst()) return orig.call(client, payload, requirements, ...rest);
    if (payload && typeof payload === "object") ownFirstAttempts.set(payload, network);
    return relayer.settle(payload, requirements, ...rest);
  };
  settle.__a402GasOrder = true;
  for (const k of Object.keys(orig)) { try { settle[k] = orig[k]; } catch { /* read-only marker */ } }
  client.settle = settle;
  return client;
}
