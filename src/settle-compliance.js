// A settle refusal on compliance grounds is FINAL.
//
// When a settlement provider refuses a payment because the payer or the payee
// is sanctioned, blocked, flagged, high-risk, or failed its compliance or AML
// screening, no other provider is asked and our own settlers never submit it:
// the same payment is not shopped around until someone settles it. The buyer
// is answered a 402 that says the settlement provider's compliance check
// refused the payment, nothing was charged, and nothing is booked owed
// (no transfer was made: a refusal that names a transaction is never read as
// this, since that transfer may still land).
//
// The same answer ends a payment our own settlers screen out before they
// submit (src/own-settler-screen.js: the OFAC SDN list the payer screens use).
//
// THE LIST. Refusals are matched on the provider's reason code and message,
// lower-cased, against the explicit patterns below. Each needs a word that
// only a compliance refusal uses (sanctions, OFAC/SDN, a block or deny list,
// AML, KYT, compliance, high risk), or an account noun beside blocked,
// flagged, restricted or frozen ("blocked address", "payer is flagged",
// "account is frozen"), so a refusal about a signature, a balance, gas or an
// expired window never reads as one. A stablecoin contract's own blacklist
// revert ("account is blacklisted") is one. Pure: no I/O.

/** The receipt reason of a payment ended by a compliance refusal. */
export const SETTLE_COMPLIANCE_REFUSED = "settle_compliance_refused";
/** The reason our own settler gives when its screen finds the payer listed. */
export const OWN_SETTLER_SCREEN_REFUSED = "own_settler_sanctions_screen";

const NOUN = "(?:address|addresses|wallet|payer|payee|sender|recipient|receiver|account|counterparty|destination|source)";
export const COMPLIANCE_REFUSAL_PATTERNS = Object.freeze([
  /\bsanction(?:s|ed)?\b/,
  /\bofac\b/,
  /\bsdn\b/,
  /\b(?:black|block|deny)[-_ ]?list(?:ed|s)?\b/,
  new RegExp(`\\b${NOUN}[-_ ](?:is[-_ ]|was[-_ ]|has been[-_ ])?(?:blocked|flagged|restricted|frozen|denied)\\b`),
  new RegExp(`\\b(?:blocked|flagged|restricted|frozen|denied|prohibited|high[-_ ]?risk)[-_ ]${NOUN}\\b`),
  /\bcompliance\b/,
  /\baml\b/,
  /\bkyt\b/,
  /\bhigh[-_ ]?risk\b/,
  /\brisk[-_ ](?:check|screen(?:ing)?|assessment)[-_ ](?:failed|rejected|refused)\b/,
  new RegExp(`\\b${OWN_SETTLER_SCREEN_REFUSED.replace(/_/g, " ")}\\b`),
  new RegExp(`\\b${SETTLE_COMPLIANCE_REFUSED.replace(/_/g, " ")}\\b`),
]);

const textOf = (x) => [x?.errorReason, x?.errorMessage, x?.invalidReason, x?.invalidMessage, x?.message]
  .filter((v) => typeof v === "string" && v).join(" ").slice(0, 4000).toLowerCase()
  // A reason code's underscores separate its words ("sanctioned_address").
  .replace(/_/g, " ");

/**
 * True when a settle answer (a failed result or a thrown error) is a refusal
 * on compliance grounds that names no transaction. A success, a transport
 * failure (a timeout, an abort, a connection error) and an answer that names
 * a transaction are never one.
 */
export function isComplianceSettleRefusal(x) {
  if (!x || typeof x !== "object") return false;
  if (x.success === true) return false;
  if (typeof x.transaction === "string" && x.transaction.trim()) return false;
  if (x.name === "AbortError" || x.name === "TimeoutError" || (typeof x.code === "string" && /^E[A-Z]+|^UND_ERR/.test(x.code))) return false;
  const text = textOf(x);
  if (!text) return false;
  return COMPLIANCE_REFUSAL_PATTERNS.some((re) => re.test(text));
}

/** The words a compliance-refused payment's 402 carries. */
export const SETTLE_COMPLIANCE_REFUSED_TEXT = "The settlement provider's compliance check refused this payment, so it was not settled and nothing was charged. It is not sent to another settlement provider.";
export const OWN_SETTLER_SCREEN_REFUSED_TEXT = "This server's sanctions screening refused this payment before it was submitted, so it was not settled and nothing was charged. It is not sent to another settlement provider.";

/** The failed settle result that ends the payment: no transaction, nothing
 *  charged, nothing owed. `own` marks our own settler's screen. */
export function complianceRefusedResult({ network = null, payer = null, own = false } = {}) {
  return {
    success: false,
    errorReason: SETTLE_COMPLIANCE_REFUSED,
    errorMessage: own ? OWN_SETTLER_SCREEN_REFUSED_TEXT : SETTLE_COMPLIANCE_REFUSED_TEXT,
    transaction: "",
    network: typeof network === "string" ? network : "",
    ...(typeof payer === "string" && payer ? { payer } : {}),
  };
}

/** True when the refusal came from our own settler's screen. */
export function isOwnScreenRefusal(x) {
  return !!x && typeof x === "object" && textOf(x).includes(OWN_SETTLER_SCREEN_REFUSED.replace(/_/g, " "));
}

// Counted per kind and network for the operator view; no address is kept.
const counts = { providerRefused: 0, ownScreenRefused: 0, ownScreenUnscreened: 0, lastAt: null, byNetwork: {} };

/** Count one compliance refusal (`kind`: "provider" or "own-screen"). */
export function noteComplianceRefusal({ network = null, via = null, kind = "provider", log = console.warn } = {}) {
  if (kind === "own-screen") counts.ownScreenRefused++; else counts.providerRefused++;
  counts.lastAt = new Date().toISOString();
  const net = typeof network === "string" && /^[a-z0-9-]{1,32}:[A-Za-z0-9-]{1,64}$/.test(network) ? network : "unknown";
  counts.byNetwork[net] = (counts.byNetwork[net] || 0) + 1;
  try { log(`[payments] settle refused on compliance grounds on ${net}${via ? ` by ${String(via).slice(0, 60)}` : ""} (${kind}); final: no other settler is asked, nothing charged`); } catch { /* logging only */ }
}

/** Count one own-settler submission made with no list to screen against. */
export function noteOwnScreenUnscreened() { counts.ownScreenUnscreened++; }

/** The operator view: counts only, never an address. */
export function settleComplianceView() {
  return { providerRefused: counts.providerRefused, ownScreenRefused: counts.ownScreenRefused, ownScreenUnscreened: counts.ownScreenUnscreened, lastAt: counts.lastAt, byNetwork: { ...counts.byNetwork } };
}

/** Test seam. */
export function __resetSettleComplianceForTests() {
  counts.providerRefused = 0; counts.ownScreenRefused = 0; counts.ownScreenUnscreened = 0; counts.lastAt = null; counts.byNetwork = {};
}
