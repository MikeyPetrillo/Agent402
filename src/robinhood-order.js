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
//     stays first. A missing reading never moves the order;
//   - our relayer's own fresh reading is low (status low, or a runway below
//     the same threshold): the facilitator stays first, so a payment is not
//     sent to a settler that cannot pay for it either.
//
// The skip is per payment and changes nothing else: verification, the 402,
// claims and the late-settlement book run exactly as they do when the
// facilitator is asked first. The settle-failure hook reads
// ownFirstAttemptOf() so our relayer is not asked twice and its own ambiguous
// answer is not handed back to it. A refusal from our relayer that
// sent nothing (ownRefusedOf) lets that hook continue to the listed
// fallbacks and then the facilitator (facilitatorRetryOf).
//
// How long our relayer has been first is a status word (robinhoodSettler on
// /api/gateway-status, settlerStatus below): ok while the facilitator settles
// first, relayer once our relayer has been first without a break for longer
// than ROBINHOOD_RELAYER_FIRST_ALERT_HOURS (default 6; 0 or off disables the
// word, which then reads off). The facilitatorFunds word leaves out a dry
// facilitator our relayer covers, so without this word a facilitator that
// stays dry for days pages nobody. The start of the current order (`since`)
// is kept in the store the caller passes (the state database in production),
// so a deploy or another replica reads the same clock.

export const ROBINHOOD_ORDER_NETWORK = "eip155:4663";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export function skipDryThreshold(env = process.env) {
  return num(String(env.ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS ?? "").trim() || NaN, 50);
}
export function readingFreshMs(env = process.env) {
  return num(env.FACILITATOR_GAS_FRESH_MS, 45 * 60_000);
}

/**
 * Hours our relayer may stay first before robinhoodSettler reads relayer.
 * Unset, blank or not a number: 6. 0 or "off": null (the word reads off).
 */
export function relayerFirstAlertHours(env = process.env) {
  const raw = String(env.ROBINHOOD_RELAYER_FIRST_ALERT_HOURS ?? "").trim();
  if (/^off$/i.test(raw)) return null;
  if (!raw) return 6;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 6;
  return n === 0 ? null : n;
}

/**
 * The robinhoodSettler word for an order state: off (no order, or the alert
 * disabled), relayer (our relayer first since longer than `hours`), ok. The
 * order itself reads unknown before its first update unless the stored clock
 * already reads relayer.
 */
export function settlerWord({ ownFirst = false, since = null } = {}, { hours = relayerFirstAlertHours(), now = Date.now() } = {}) {
  if (hours == null) return "off";
  if (!ownFirst) return "ok";
  return Number.isFinite(since) && now - since > hours * 3_600_000 ? "relayer" : "ok";
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

/** True when `host` has at least one fresh, read gas row on `network`. */
function facilitatorHasFreshReading(readings, { host, network, freshMs, now }) {
  return !!host && (Array.isArray(readings) ? readings : []).some((r) =>
    r && !r.own && r.network === network && r.facilitator === host
    && (r.status === "ok" || r.status === "low")
    && Number.isFinite(r.runway) && now - atOf(r) <= freshMs);
}

/**
 * True when a fresh, read gas row of our own relayer on `network` is low:
 * status low, or a runway below `threshold`. Unread or stale: false.
 */
export function ownRelayerIsLow(readings, { network = ROBINHOOD_ORDER_NETWORK, threshold = skipDryThreshold(), freshMs = readingFreshMs(), now = Date.now() } = {}) {
  return (Array.isArray(readings) ? readings : []).some((r) =>
    r && r.own && r.network === network && now - atOf(r) <= freshMs
    && (r.status === "low" || (r.status === "ok" && Number.isFinite(r.runway) && r.runway < threshold)));
}

/**
 * The order state for one facilitator host. `update(readings)` re-decides it
 * and logs one line when the order changes; `ownFirst()` is read per settle.
 *
 * `store` ({ load(): body | null, save(body) }, both may be async) keeps
 * { host, ownFirst, since } across processes. After each update the stored
 * body is read again and reconciled: both say our relayer is first, the
 * earlier since wins (a deploy or a second replica keeps the clock); they
 * disagree, this process's decision is written with its own since. A store
 * that throws leaves this process's clock as it is.
 *
 * A facilitator-first decision taken on a reading (the facilitator read
 * funded, or our relayer read low) records `resetAt`, carried in every later
 * write. A relayer-first clock that started before the latest reset known to
 * this process restarts at that reset, so a replica that has not yet seen the
 * facilitator funded can neither write its old since back nor hand it to a
 * peer that turns relayer-first later.
 *
 * The stored body is also read once when the order is created, so the word
 * reflects the stored clock before the first update: relayer when it already
 * reads relayer, unknown otherwise (never ok on no reading of its own).
 */
export function createRobinhoodOrder({ host, network = ROBINHOOD_ORDER_NETWORK, threshold = skipDryThreshold(), freshMs = readingFreshMs(), now = Date.now, log = console.warn, store = null } = {}) {
  const state = { ownFirst: false, since: null, checkedAt: null, resetAt: null, evidenced: false, stored: null };
  let syncing = null;
  let again = false;
  const timeOf = (v) => { const t = typeof v === "number" ? v : Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; };
  const sinceOf = (b) => timeOf(b?.since);
  // The latest reset this process knows of, from its own decisions or the store.
  const noteReset = (t) => { if (t != null && (state.resetAt == null || t > state.resetAt)) state.resetAt = t; };
  // A relayer-first clock never starts before the latest reset.
  const clampSince = () => { if (state.ownFirst && state.resetAt != null && (state.since == null || state.since < state.resetAt)) state.since = state.resetAt; };
  async function reconcile() {
    const stored = await store.load();
    const mine = !!stored && stored.host === host;
    const sOwn = mine && stored.ownFirst === true;
    const sSince = mine ? sinceOf(stored) : null;
    const sReset = mine ? timeOf(stored.resetAt) : null;
    if (state.checkedAt == null) { // nothing decided yet: never write a guess, only read the stored clock
      state.stored = mine ? { ownFirst: sOwn, since: sSince } : null;
      noteReset(sReset);
      return;
    }
    noteReset(sReset);
    clampSince();
    // A stored relayer-first start before the latest reset is not a clock to keep.
    const sLive = sOwn && sSince != null && (state.resetAt == null || sSince >= state.resetAt);
    if (state.ownFirst && sLive && (state.since == null || sSince < state.since)) {
      state.since = sSince; // the clock started earlier, in another process
      if (sReset === state.resetAt) return;
    }
    if (state.ownFirst === sOwn && sSince === state.since && sReset === state.resetAt) return;
    // Facilitator first for want of a reading is a guess: it never overwrites a stored relayer-first clock.
    if (!state.ownFirst && sOwn && !state.evidenced) return;
    // Facilitator first in both, and the stored reset is as recent as ours: nothing to keep.
    if (!state.ownFirst && !sOwn && (state.resetAt == null || (sReset != null && sReset >= state.resetAt))) return;
    await store.save({ host, network, ownFirst: state.ownFirst, since: state.since, ...(state.resetAt != null ? { resetAt: state.resetAt } : {}) });
  }
  function sync() {
    if (!store) return Promise.resolve();
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      do {
        again = false;
        try { await reconcile(); } catch { /* the store is advisory: this process keeps its own clock */ }
      } while (again);
    })().finally(() => { syncing = null; });
    return syncing;
  }
  // Read the stored clock once at creation, so the first status read reflects it.
  if (store) void sync();
  return {
    host,
    update(readings) {
      const t = now();
      state.checkedAt = t;
      const dry = facilitatorIsDry(readings, { host, network, threshold, freshMs, now: t });
      const ownLow = dry && ownRelayerIsLow(readings, { network, threshold, freshMs, now: t });
      const first = dry && !ownLow;
      // Facilitator first on a reading (funded, or our relayer low), not for
      // want of one: the first such decision of each era is a reset.
      const funded = !dry && facilitatorHasFreshReading(readings, { host, network, freshMs, now: t });
      if (!first && (funded || ownLow) && !state.evidenced) { noteReset(t); state.evidenced = true; }
      if (first) state.evidenced = false;
      if (first === state.ownFirst) { clampSince(); void sync(); return false; }
      state.ownFirst = first;
      state.since = t;
      clampSince();
      void sync();
      try {
        log(first
          ? `Robinhood: ${host} dry, own relayer first`
          : ownLow ? `Robinhood: ${host} dry but own relayer low, facilitator first`
          : `Robinhood: ${host} funded again, facilitator first`);
      } catch { /* logging only */ }
      return true;
    },
    ownFirst() { return state.ownFirst; },
    /** Resolves once the store has been reconciled with the latest update. */
    synced() { return syncing || Promise.resolve(); },
    /** The robinhoodSettler word: { status } publicly, the clock for the operator.
     *  Before the first update: relayer when the stored clock reads relayer
     *  (its start no earlier than the latest stored reset), else unknown. */
    status({ full = false, env = process.env, at = now() } = {}) {
      const hours = relayerFirstAlertHours(env);
      const pre = state.checkedAt == null;
      const seen = pre ? (state.stored?.ownFirst && (state.resetAt == null || (state.stored.since != null && state.stored.since >= state.resetAt)) ? state.stored : null) : state;
      const status = hours == null ? "off" : pre ? (seen && settlerWord(seen, { hours, now: at }) === "relayer" ? "relayer" : "unknown") : settlerWord(state, { hours, now: at });
      const shown = seen || state;
      return full ? { status, alertHours: hours, first: pre ? (seen ? "own relayer (stored)" : "not read yet") : state.ownFirst ? "own relayer" : "facilitator", since: shown.since ? new Date(shown.since).toISOString() : null } : { status };
    },
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

/**
 * Where the order's since is kept: one state-database document per network
 * (robinhood-order:<network>), so a deploy or another replica reads the same
 * clock. No state database: null (this process's clock only).
 */
export async function stateDbOrderStore(network = ROBINHOOD_ORDER_NETWORK, env = process.env) {
  const { stateDbEnabled, documents } = await import("./state-db.js");
  if (!stateDbEnabled(env)) return null;
  const name = `robinhood-order:${network}`;
  return {
    async load() { const row = await documents.get(name); return row ? row.body : null; },
    async save(body) { await documents.put(name, body); },
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

// paymentPayload: payments our relayer refused before sending anything
// (`nothingSent`, src/robinhood-relayer.js). Asked again, it refuses at once.
const ownRefused = new WeakSet();

/** True when our relayer refused this payload with nothing sent. */
export function ownRefusedOf(paymentPayload) {
  return !!paymentPayload && typeof paymentPayload === "object" && ownRefused.has(paymentPayload);
}

/**
 * Our relayer, remembering a payload it refused with nothing sent: the same
 * payload is refused again without a second attempt, so no path in the
 * settle chain re-asks it for a payment it already gave up.
 */
export function withOwnRefusalMemo(relayer) {
  if (!relayer || typeof relayer.settle !== "function" || relayer.__a402OwnRefusalMemo) return relayer;
  return Object.assign(Object.create(relayer), {
    __a402OwnRefusalMemo: true,
    async settle(payload, requirements, ...rest) {
      if (ownRefusedOf(payload)) return { success: false, errorReason: "own_relayer_refused", errorMessage: "own relayer already refused this payment", transaction: "", network: requirements?.network, nothingSent: true };
      const result = await relayer.settle(payload, requirements, ...rest);
      if (result?.success !== true && result?.nothingSent === true && payload && typeof payload === "object") ownRefused.add(payload);
      return result;
    },
  });
}

// paymentPayload -> the listed facilitator's own settle, for a payment our
// relayer settled first: after its nothing-sent refusal the hook asks the
// facilitator through this, never through the gas-ordered wrapper again.
const facilitatorRetries = new WeakMap();

/** The facilitator's { name, settle } for a payload our relayer was asked first, or null. */
export function facilitatorRetryOf(paymentPayload) {
  return (paymentPayload && typeof paymentPayload === "object" && facilitatorRetries.get(paymentPayload)) || null;
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
    if (payload && typeof payload === "object") {
      ownFirstAttempts.set(payload, network);
      facilitatorRetries.set(payload, { name: order.host || "facilitator", settle: (p, rq) => orig.call(client, p, rq, ...rest) });
    }
    return relayer.settle(payload, requirements, ...rest);
  };
  settle.__a402GasOrder = true;
  for (const k of Object.keys(orig)) { try { settle[k] = orig[k]; } catch { /* read-only marker */ } }
  client.settle = settle;
  return client;
}
