// TypeSafe (the judgment model behind /v1/judge and the router's tool pick)
// runs on prepaid credits and publishes no balance API, so we meter it here:
// every successful response reports its own `usage.input_tokens`, and that
// running total, priced at the operator's configured input rate, against a
// credit figure the operator sets gives an estimated remainder.
//
//   TYPESAFE_CREDIT_USD      credit loaded on the account (unset = unconfigured)
//   TYPESAFE_CREDIT_SINCE    ISO date that figure applies from; changing it
//                            restarts the count (set it when you top up)
//   TYPESAFE_LOW_USD         low-water mark, default 10
//   TYPESAFE_USD_PER_MTOK    input price per million tokens (required; no
//                            vendor rate is kept in code)
//
// A 401/402/403 from TypeSafe is also read as "low": an exhausted or rejected
// account must page, not look like an outage. Public surfaces get the status
// word only; the operator sees the figures.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const TYPESAFE_USAGE_FILE = process.env.TYPESAFE_USAGE_FILE || "/data/typesafe-usage.json";
const REJECTED_WINDOW_MS = 60 * 60_000;
const state = { since: null, inputTokens: 0, calls: 0, rejectedAt: 0, loaded: false };
let persistTimer = null;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const sinceSetting = () => String(process.env.TYPESAFE_CREDIT_SINCE || "").trim() || null;

function load() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const o = JSON.parse(readFileSync(TYPESAFE_USAGE_FILE, "utf8"));
    state.since = typeof o.since === "string" ? o.since : null;
    state.inputTokens = num(o.inputTokens, 0);
    state.calls = num(o.calls, 0);
  } catch { /* no file yet, or no volume */ }
}

// A new TYPESAFE_CREDIT_SINCE (a top-up) starts the count again from zero.
function alignBaseline() {
  load();
  const since = sinceSetting();
  if (since !== state.since) { state.since = since; state.inputTokens = 0; state.calls = 0; schedulePersist(); }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const tmp = `${TYPESAFE_USAGE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ since: state.since, inputTokens: state.inputTokens, calls: state.calls }));
      renameSync(tmp, TYPESAFE_USAGE_FILE);
    } catch { /* best-effort: no volume in local/dev */ }
  }, 5_000);
  persistTimer.unref?.();
}

/** Book one successful TypeSafe response's reported usage. Never throws. */
export function noteTypesafeUsage(usage) {
  try {
    const t = Number(usage?.input_tokens);
    if (!Number.isFinite(t) || t < 0) return;
    alignBaseline();
    state.inputTokens += t;
    state.calls++;
    schedulePersist();
  } catch { /* metering must never break a call */ }
}

/** TypeSafe refused our key (401/402/403): read as low until an hour passes. */
export function noteTypesafeRejected() { state.rejectedAt = Date.now(); }

export function typesafeCreditStatus(now = Date.now()) {
  alignBaseline();
  const credit = Number(process.env.TYPESAFE_CREDIT_USD);
  const rejected = state.rejectedAt > 0 && now - state.rejectedAt < REJECTED_WINDOW_MS;
  const rate = Number(process.env.TYPESAFE_USD_PER_MTOK);
  const spentUsd = rate > 0 ? (state.inputTokens * rate) / 1e6 : null;
  if (!(credit > 0) || spentUsd === null) return { status: rejected ? "low" : "unconfigured", rejected, calls: state.calls, inputTokens: state.inputTokens, spentUsd };
  const remainingUsd = credit - spentUsd;
  const low = rejected || remainingUsd < num(process.env.TYPESAFE_LOW_USD, 10);
  return { status: low ? "low" : "ok", rejected, since: state.since, calls: state.calls, inputTokens: state.inputTokens, spentUsd, remainingUsd };
}

export function _resetTypesafeCreditForTest() { state.since = null; state.inputTokens = 0; state.calls = 0; state.rejectedAt = 0; state.loaded = true; }
