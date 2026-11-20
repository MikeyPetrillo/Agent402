// Which clients' 402s carry MPP offers.
//
// A client whose User-Agent starts with a listed prefix gets a 402 with no
// `WWW-Authenticate: Payment` challenge (evm, tempo or card): the x402
// PAYMENT-REQUIRED header and the 402 body are exactly what every other client
// gets, so it pays over x402. The default list is "python-httpx/": clients
// with that User-Agent pay over x402, and a payment manager that prefers an
// MPP challenge whenever one is offered and stops when that payment fails never
// reaches the x402 offer in the same 402.
//
// OPT IN. `X-Payment-Offers: mpp` (or `all`; a comma list, read without regard
// to case) restores the MPP challenges, byte for byte as other clients get
// them. Any other value restores nothing. So does `Accept-Payment`, the MPP
// request header an MPP client library sends to name its methods: one
// well-formed `method/intent` entry (either side may be `*`) whose q is not 0
// is enough. A payment manager that sends neither keeps the x402 offer alone.
//
// NEVER GATED. A request that arrives with an MPP credential (`Authorization:
// Payment ...`) is verified as before, and its 402 carries fresh challenges as
// before. The MPP shim removes the header once it translates the credential, so
// the request's raw header list and the shim's own mark are read as well.
//
// EVERY OTHER CLIENT is untouched: no header, no Vary, no body change. The
// gated client's 402 varies on both opt-in headers (it already varies on
// User-Agent), so a cache never hands one answer to the other.
//
// Switch: MPP_OFFER_WITHHOLD_USER_AGENTS, a comma list of prefixes (unset or
// blank: the default; `off`: the gate is off). Read at call time.
// Decided once per request (the evm, tempo and card appenders all ask) and
// counted once: per process, counts only, on the operator view of
// /api/gateway-status (mppEvmDomainFallback.offerGate).

/** The request header that restores the MPP offers. */
export const OFFER_REQUEST_HEADER = "X-Payment-Offers";
/** The MPP request header that restores them too, when it names a method. */
export const ACCEPT_PAYMENT_HEADER = "Accept-Payment";
/** The values of that header that restore them. */
export const OFFER_OPT_IN_VALUES = Object.freeze(["mpp", "all"]);
/** The User-Agent prefixes gated when the switch is unset. */
export const DEFAULT_WITHHELD_USER_AGENT_PREFIXES = Object.freeze(["python-httpx/"]);

const DECISION = Symbol.for("agent402.mppOfferGateDecision");
const counts = { withheld: 0, optedIn: 0 };

/** The gated prefixes, lowercased; empty when the gate is off. */
export function withheldUserAgentPrefixes(env = process.env) {
  const raw = String(env?.MPP_OFFER_WITHHOLD_USER_AGENTS ?? "").trim();
  if (!raw) return [...DEFAULT_WITHHELD_USER_AGENT_PREFIXES];
  if (raw.toLowerCase() === "off") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function mppOfferGateEnabled(env = process.env) {
  return withheldUserAgentPrefixes(env).length > 0;
}

/** The clause every text that says a 402 carries the MPP challenges adds,
 *  built from the switch: which clients get the x402 offer alone and the
 *  header that restores the challenges. "" when the gate is off. `code` wraps
 *  a literal (markdown backticks by default). */
export function mppOfferGateClause({ code = (s) => `\`${s}\``, env = process.env } = {}) {
  const prefixes = withheldUserAgentPrefixes(env).map((p) => code(p));
  if (prefixes.length === 0) return "";
  const names = prefixes.length === 1 ? prefixes[0] : `${prefixes.slice(0, -1).join(", ")} or ${prefixes.at(-1)}`;
  return `a client whose User-Agent starts with ${names} gets the x402 offer alone, with no ${code("WWW-Authenticate: Payment")} challenge, unless it sends ${code(`${OFFER_REQUEST_HEADER}: mpp`)} or an ${code(ACCEPT_PAYMENT_HEADER)} header naming an MPP method`;
}

/** The same clause as a sentence; "" when the gate is off. */
export function mppOfferGateSentence(opts) {
  const c = mppOfferGateClause(opts);
  return c ? `${c[0].toUpperCase()}${c.slice(1)}.` : "";
}

const headerList = (req, name) => {
  const v = req?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "";
};

// One Accept-Payment entry: `method/intent`, each a token or `*`, then
// optional `;name=value` parameters. Bounded tokens, anchored, no nested
// quantifier: linear in the entry's length.
const ACCEPT_PAYMENT_ENTRY = /^(?:[a-z0-9_-]{1,64}|\*)[ \t]*\/[ \t]*(?:[a-z0-9_-]{1,64}|\*)$/i;
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** True when one Accept-Payment entry names a method the client takes:
 *  well formed, with no q or a valid q above 0. */
function acceptPaymentEntryTakes(part) {
  const [entry, ...params] = part.split(";");
  if (!ACCEPT_PAYMENT_ENTRY.test(entry.trim())) return false;
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== "q") continue;
    const q = p.slice(eq + 1).trim();
    return Q_VALUE.test(q) && Number(q) > 0;
  }
  return true;
}

/** True when the request asks for the MPP offers: the opt-in header, or an
 *  Accept-Payment header that names an MPP method. */
export function requestOptsIntoMppOffers(req) {
  if (headerList(req, OFFER_REQUEST_HEADER).split(",").some((t) => OFFER_OPT_IN_VALUES.includes(t.trim().toLowerCase()))) return true;
  return headerList(req, ACCEPT_PAYMENT_HEADER).split(",").some(acceptPaymentEntryTakes);
}

const PAYMENT_SCHEME = /^\s*payment\s/i;

/** True when the request arrived with an MPP credential. */
function arrivedWithMppCredential(req) {
  if (req?.mppCredential === true) return true;
  if (PAYMENT_SCHEME.test(String(req?.headers?.authorization ?? ""))) return true;
  const raw = Array.isArray(req?.rawHeaders) ? req.rawHeaders : [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === "authorization" && PAYMENT_SCHEME.test(String(raw[i + 1]))) return true;
  }
  return false;
}

function userAgentGated(req, prefixes) {
  const ua = String(req?.headers?.["user-agent"] ?? "").trimStart().toLowerCase();
  return ua !== "" && prefixes.some((p) => ua.startsWith(p));
}

/**
 * Should this request's 402 be sent without MPP challenges? Decided once per
 * request; the first decision for a gated client adds the opt-in headers to
 * the response's Vary and is counted.
 */
export function mppOffersWithheldFor(req) {
  if (!req || typeof req !== "object") return false;
  if (typeof req[DECISION] === "boolean") return req[DECISION];
  const decide = () => {
    const prefixes = withheldUserAgentPrefixes();
    if (prefixes.length === 0) return false;
    if (arrivedWithMppCredential(req)) return false;
    if (!userAgentGated(req, prefixes)) return false;
    try { req.res?.vary?.(OFFER_REQUEST_HEADER); req.res?.vary?.(ACCEPT_PAYMENT_HEADER); } catch { /* a Vary is never load-bearing for the decision */ }
    if (requestOptsIntoMppOffers(req)) { counts.optedIn++; return false; }
    counts.withheld++;
    return true;
  };
  const verdict = decide();
  Object.defineProperty(req, DECISION, { value: verdict, enumerable: false, configurable: true });
  return verdict;
}

/** Operator view: the switch, the list and the counts since this process
 *  started. Never published. */
export function mppOfferGateStatus() {
  const prefixes = withheldUserAgentPrefixes();
  return { enabled: prefixes.length > 0, userAgentPrefixes: prefixes, withheld: counts.withheld, optedIn: counts.optedIn };
}

/** Test seam only. */
export function _resetMppOfferGate() {
  counts.withheld = 0;
  counts.optedIn = 0;
}
