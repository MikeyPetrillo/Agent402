// What a tool's 200 promised, and whether the answer kept the promise.
//
// One grading vocabulary for three readers: the catalog sweeps
// (scripts/sweep-shape.js, test-all and the non-metered sweep), the weekly
// catalog buy (scripts/catalog-buy*.js) and production traffic
// (classifyAnswer, read by src/tool-failure-monitor.js on every final 200 of
// a catalog route). The sweeps grade a tool's answer to its OWN example
// input; production grades whatever a buyer sent, so the serve-time rules
// below are narrower than the sweeps' and every class is counted, never
// acted on: classification is observation only and never touches the
// response, its status, settlement or billing.
//
// Classes of a final 200:
//   ok            the answer carries what its documented example shows.
//   empty         every array the documented example shows populated is
//                 empty, or a primary scalar (PRIMARY_KEYS) the example shows
//                 set is null or "". One empty secondary list (a whois status,
//                 a coin's platforms) is a normal answer, so the array rule
//                 needs ALL of them empty. Not flagged: an answer that says
//                 so in fields (src/partial-answer.js `matched: 0`,
//                 `truncated` / `complete: false`, `found: false`,
//                 `exists: false`), a pure-CPU tool (its output is a function
//                 of the buyer's input, so an empty list is the input's
//                 answer), and a tool whose contract allows an empty result
//                 (EMPTY_RESULT_OK below, or `discovery.emptyOk` on the tool:
//                 true for the whole answer, or the array keys it excuses).
//   error-shaped  an `error` (set), `errors` (non-empty) or `ok: false` in a
//                 200, where the documented example does not carry that key
//                 (a validator's `errors` list and code-run's `error` are the
//                 contract), or a skill pack whose every step reports
//                 `ok: false`.
//   unchecked     not a JSON object or array, no documented example, or a
//                 top level too wide to read cheaply.
//
// Cost: top-level keys and array lengths only, never a walk and never a
// serialization, so a large body costs what a small one does. Reasons are
// field names, never values.

export const ANSWER_CLASSES = ["ok", "empty", "error-shaped", "unchecked"];
// Top-level scalars whose null (or "") answer is the failure itself.
export const PRIMARY_KEYS = ["price", "rate", "answer", "markdown", "text", "content"];
const ERROR_KEYS = ["error", "errors", "ok"];
const MAX_TOP_KEYS = 500;
const MAX_STEPS = 64;

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Top-level keys whose documented example value is a non-empty array. */
export function populatedArrayKeys(example) {
  if (!isRecord(example)) return [];
  return Object.entries(example).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k]) => k);
}

/** Documented top-level keys the body lacks ([] when there is nothing to compare). */
export function missingExampleKeys(example, body) {
  if (!isRecord(body) || !isRecord(example)) return [];
  return Object.keys(example).filter((k) => !Object.prototype.hasOwnProperty.call(body, k));
}

/** Keys the example shows populated that the body answers as an empty array
 *  (each on its own: the sweeps' rule for the example's own input). */
export function emptyExampleArrays(example, body, excused = new Set()) {
  if (!isRecord(body)) return [];
  return populatedArrayKeys(example).filter((k) => !excused.has(k) && Array.isArray(body[k]) && body[k].length === 0);
}

// Tools whose documented contract allows an empty answer for a valid input:
// slug -> true (the whole answer) or the array keys that may be empty. A
// tool can say the same itself with `discovery.emptyOk`, which wins.
export const EMPTY_RESULT_OK = new Map([
  // A clean subject has nothing to list: no warnings, alerts, recalls, flags.
  ["token-safety", true],
  ["weather-alerts", true],
  ["device-recalls", true],
  ["drug-recalls", true],
  ["food-recalls", true],
  ["vehicle-recalls", true],
  ["seller-dossier", true],
  ["seller-payability", true],
  ["page-speed", true],
  // Filters over a window or a subject that may hold no rows.
  ["edgar-insider-trades", true],
  ["earthquakes", true],
  ["fema-disasters", true],
  ["event-logs", true],
  ["onchain-sql", true],
  ["search-suggest", true],
  // Keyed on the payer: a payer with no history, store or grants lists none.
  ["memory-grants", true],
  ["memory-log", true],
  ["memory-read", true],
  ["memory-recall", true],
  ["receipts", true],
  ["my-usage", true],
  // A wallet, address or transaction with nothing of that kind.
  ["eas-attestations", true],
  ["asset-transfers", true],
  ["token-balances", true],
  ["wallet-balance", true],
  ["wallet-balances", true],
  ["wallet-transactions", true],
  ["tx-receipt", true],
  ["calldata-decode", true],
  // A host or page without the record, header or element asked about.
  ["dns", true],
  ["dns-lookup", true],
  ["email-validate", true],
  ["ip-info", true],
  ["robots-check", true],
  ["spf-check", true],
  ["tech-stack", true],
  ["favicon-grab", true],
  ["html-frames", true],
  ["unshorten-url", true],
  // One list may be empty, the rest still checked.
  ["nft-metadata", ["attributes"]],
  ["coin-profile", ["platforms"]],
  ["wikidata-entity", ["aliases"]],
]);

// The answer says in fields that it holds nothing, or only part.
function declaresEmpty(body) {
  return body.found === false || body.exists === false || body.matched === 0
    || body.truncated === true || body.complete === false;
}

const isSet = (v) => v !== undefined && v !== null && v !== false && v !== "" && !(isRecord(v) && Object.keys(v).length === 0);
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : isRecord(v) ? Object.keys(v).length > 0 : isSet(v));

/**
 * The checkable contract of one catalog tool, computed once per tool.
 * `deterministic`: a pure-CPU tool (no egress, key or model); its empty
 * answers are its input's answer and are never flagged.
 */
export function answerContractOf(def, { deterministic = false } = {}) {
  const slug = String(def?.slug || "");
  const example = def?.discovery?.output?.example;
  if (!example || typeof example !== "object") return { slug, checkable: false };
  const declared = def?.discovery?.emptyOk ?? EMPTY_RESULT_OK.get(slug);
  const skipEmpty = deterministic || declared === true;
  const excused = new Set(Array.isArray(declared) ? declared.map(String) : []);
  if (Array.isArray(example)) return { slug, checkable: true, root: !skipEmpty && example.length > 0, populated: [], primary: [], documented: new Set(), steps: false };
  return {
    slug,
    checkable: true,
    root: false,
    populated: skipEmpty ? [] : populatedArrayKeys(example).filter((k) => !excused.has(k)),
    primary: skipEmpty ? [] : PRIMARY_KEYS.filter((k) => !excused.has(k) && (typeof example[k] === "string" ? example[k] !== "" : typeof example[k] === "number")),
    documented: new Set(ERROR_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(example, k))),
    steps: Array.isArray(example.steps) && example.steps.some((s) => isRecord(s) && typeof s.ok === "boolean"),
  };
}

/**
 * The class of one final 200 answer: { klass, reasons } (reasons are field
 * names). Never throws: anything unexpected is `unchecked`.
 */
export function classifyAnswer(contract, body) {
  try {
    if (!contract?.checkable) return { klass: "unchecked", reasons: ["no-example"] };
    if (Array.isArray(body)) return contract.root && body.length === 0 ? { klass: "empty", reasons: ["(root)"] } : { klass: "ok", reasons: [] };
    if (!isRecord(body)) return { klass: "unchecked", reasons: ["not-object"] };
    // Object.keys on a wide object is the one cost that scales; bound it.
    let n = 0;
    for (const k in body) { if (++n > MAX_TOP_KEYS) return { klass: "unchecked", reasons: ["too-wide"] }; void k; }
    const reasons = [];
    const doc = contract.documented;
    if (!doc.has("error") && isSet(body.error)) reasons.push("error");
    if (!doc.has("errors") && nonEmpty(body.errors)) reasons.push("errors");
    if (!doc.has("ok") && body.ok === false) reasons.push("ok");
    if (contract.steps && Array.isArray(body.steps) && body.steps.length > 0 && body.steps.length <= MAX_STEPS && body.steps.every((s) => isRecord(s) && s.ok === false)) reasons.push("steps");
    if (reasons.length) return { klass: "error-shaped", reasons };
    if (declaresEmpty(body)) return { klass: "ok", reasons: [] };
    const present = contract.populated.filter((k) => Array.isArray(body[k]));
    if (present.length && present.every((k) => body[k].length === 0)) reasons.push(...present);
    for (const k of contract.primary) if (Object.prototype.hasOwnProperty.call(body, k) && (body[k] === null || body[k] === "")) reasons.push(k);
    return reasons.length ? { klass: "empty", reasons } : { klass: "ok", reasons: [] };
  } catch {
    return { klass: "unchecked", reasons: ["unreadable"] };
  }
}

/**
 * Hold the object a response's res.json is called with, by reference, so it
 * can be classified after the response closed. The call itself is passed
 * through untouched (same arguments, same `this`, same return), so the bytes
 * on the wire are what they would be without it. Returns { has(), body() }.
 */
export function observeJsonAnswer(res) {
  let seen = false, held;
  const original = res?.json;
  if (typeof original !== "function") return { has: () => false, body: () => undefined };
  res.json = function observedJson(...args) {
    const body = args[0];
    if (body !== null && typeof body === "object") { seen = true; held = body; } else { seen = false; held = undefined; }
    return original.apply(this, args);
  };
  return { has: () => seen, body: () => held };
}

/**
 * Live-data slugs whose outside sales in a window all returned one identical
 * body: rows [{ slug, sales, distinctAnswers, payers }] from the sales
 * ledger's response_sha256 aggregate. A live-data tool (anything not pure-CPU)
 * answering the same bytes to many sales is serving a canned or stuck answer.
 */
export function identicalAnswerFlags(rows, { minSales = 5, isLive = () => true } = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const sales = Number(r?.sales) || 0, distinct = Number(r?.distinctAnswers) || 0;
    if (!r?.slug || sales < minSales || distinct !== 1) continue;
    let live = false;
    try { live = !!isLive(String(r.slug)); } catch { live = false; }
    if (live) out.push({ slug: String(r.slug), sales, distinctAnswers: distinct, payers: Number(r.payers) || 0 });
  }
  return out.sort((a, b) => b.sales - a.sales || a.slug.localeCompare(b.slug));
}
