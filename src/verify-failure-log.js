// One log line for a payment the facilitator refused at verify: the network,
// the scheme, the refusal, the route's slug and a shortened payer.
//
// Every value is read as data from a request, so every value is treated as
// hostile: a field that is not a string or a finite number prints "?", never
// through its own toString (an object whose toString is not a function throws
// in a template literal), control characters and spaces never reach the line,
// and each part has its own length bound, so the line is one line of at most
// MAX_LINE characters whatever arrives. Nothing here throws.
//
// The payer is shortened to its first characters and never case-folded: a
// base58 (Solana), base32 (Algorand) or Stellar address differs by case alone
// from another wallet's. An EVM address keeps "0x" and four hex digits. The
// full address is never printed.
const MAX_LINE = 480;
const MAX_REASON = 300;

/** A printable token of at most `max` characters, or "?" for anything that is not a string or a finite number. Never throws. */
export function safeLogToken(value, max = 64) {
  let s;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" && Number.isFinite(value)) s = String(value);
  else return "?";
  let out = "";
  for (let i = 0; i < s.length && out.length < max; i++) {
    const c = s.charCodeAt(i);
    out += c > 0x20 && c < 0x7f ? s[i] : "?";
  }
  return out || "?";
}

/** Free text on one line: whitespace runs become one space, other control characters "?", bounded. Never throws. */
export function safeLogText(value, max = MAX_REASON) {
  if (typeof value !== "string") return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
  let out = "";
  let space = false;
  for (let i = 0; i < value.length && out.length < max; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) { space = out.length > 0; continue; }
    if (space) { out += " "; space = false; }
    out += c > 0x20 && c !== 0x7f && c !== 0x2028 && c !== 0x2029 ? value[i] : "?";
  }
  return out || "?";
}

/**
 * The shortened payer: the first four characters of an address as written
 * ("0x" plus four hex digits for an EVM address), or "?" when the value is
 * not an address-shaped string. Case is kept exactly. Never throws.
 */
export function shortPayer(value) {
  if (typeof value !== "string") return "?";
  const n = value.length;
  if (n < 26 || n > 128) return "?";
  for (let i = 0; i < n; i++) {
    const c = value.charCodeAt(i);
    const alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!alnum) return "?";
  }
  return value.charCodeAt(0) === 0x30 && (value[1] === "x" || value[1] === "X") ? value.slice(0, 6) : value.slice(0, 4);
}

/**
 * The line. `verb` is "failed" (the facilitator's verify threw) or
 * "rejected" (it answered isValid:false).
 */
export function verifyFailureLine({ verb = "failed", network, scheme, reason, slug, payer } = {}) {
  // A facilitator's text can repeat the payer it was asked about: the whole
  // address is cut to the same short form there too.
  const short = shortPayer(payer);
  if (short !== "?" && typeof reason === "string" && reason.includes(payer)) reason = reason.slice(0, 4 * MAX_REASON).split(payer).join(`${short}...`);
  const line = `[payments] facilitator VERIFY ${verb === "rejected" ? "rejected" : "failed"} on ${safeLogToken(network, 80)} ${safeLogToken(scheme, 24)}` +
    ` route=${safeLogToken(slug, 64)} payer=${short}: ${safeLogText(reason, MAX_REASON)}`;
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
}

/**
 * The paying wallet a refused payment names, as written, or null: the EVM
 * authorization's `from` (EIP-3009 or Permit2), else the payer the
 * facilitator's answer or error carries, else `svm(paymentPayload)` for a
 * Solana transaction. Unverified text, for the log line's short form only.
 * Never throws.
 */
export function payerNamedBy(ctx, { svm = null } = {}) {
  try {
    const inner = ctx?.paymentPayload?.payload;
    for (const v of [inner?.authorization?.from, inner?.permit2Authorization?.from, ctx?.result?.payer, ctx?.error?.payer]) {
      if (typeof v === "string" && v) return v;
    }
    const s = typeof svm === "function" ? svm(ctx?.paymentPayload) : null;
    return typeof s === "string" && s ? s : null;
  } catch { return null; }
}
