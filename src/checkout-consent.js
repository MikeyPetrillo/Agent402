// What a card buyer agrees to on the Stripe Checkout page, for the two card
// products sold to people: a report (one payment) and a monitor (a monthly
// subscription).
//
// Both sessions require the Terms of Service checkbox
// (consent_collection.terms_of_service: "required"), with the acceptance line
// naming the arbitration and class-action waiver, and a submit line stating
// the refund rule (reports) or the renewal terms (monitors). A monitor also
// takes a separate, required automatic-renewal consent naming the monthly
// price and the price after any promotional first month. A report buyer can
// turn the follow-up emails off at checkout (src/followups.js reads it).
//
// Stripe shows the terms checkbox only when the account's public details name
// a Terms of Service URL; without one it refuses the session. That refusal is
// answered by creating the session again with a required "I agree" dropdown in
// its place (the same consent, the way the credits checkout takes it), logged
// once, so a buyer is never turned away for a dashboard setting.
//
// Custom field limits (Stripe): at most 3 fields, a label of at most 50
// characters, a dropdown option label of at most 100.

const trimBase = (b) => String(b || "").replace(/\/+$/, "");
const usd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

/** The acceptance line beside the terms checkbox (Markdown links). */
export function termsAcceptanceMessage(baseUrl) {
  const b = trimBase(baseUrl);
  return `I agree to the [Terms of Service](${b}/terms), including [binding individual arbitration and the class-action waiver](${b}/terms#disputes).`;
}

/** The report's line above the pay button: the refund rule, before purchase. */
export const REPORT_REFUND_LINE = "One-time charge. Your report is generated once for this payment; if it cannot be generated, the charge is refunded automatically. A delivered report is final.";

/** The follow-up email choice on a report checkout: on by default, off with one choice. */
export const FOLLOWUPS_FIELD = Object.freeze({
  key: "followups",
  label: { type: "custom", custom: "Follow-up emails about this report" },
  type: "dropdown",
  optional: true,
  dropdown: { default_value: "yes", options: [{ label: "Yes, send follow-up emails", value: "yes" }, { label: "No follow-up emails", value: "no" }] },
});

/** The monitor's separate automatic-renewal consent: required, one choice. */
export function autoRenewField(priceCents) {
  return {
    key: "autorenew",
    label: { type: "custom", custom: "Automatic monthly renewal" },
    type: "dropdown",
    optional: false,
    dropdown: { options: [{ label: `I agree: renews monthly at ${usd(priceCents)} plus any tax until I cancel`, value: "agreed" }] },
  };
}

/** The monitor's renewal statement for the acceptance and submit lines. */
export function monitorRenewalStatement(priceCents, baseUrl) {
  const b = trimBase(baseUrl);
  let host = b;
  try { host = new URL(b).host; } catch { /* the base as given */ }
  return `This monitor renews automatically every month at ${usd(priceCents)} a month plus applicable tax, charged to this card until you cancel. If a promotion code lowers the first month, every later month is ${usd(priceCents)}. Cancel anytime online from the manage link in your monitor emails or at [${host}/monitors](${b}/monitors#manage); canceling stops the next renewal and the current month is not refunded.`;
}

const TERMS_DROPDOWN = Object.freeze({ key: "terms", label: { type: "custom", custom: "Terms of Service" }, type: "dropdown", optional: false, dropdown: { options: [{ label: "I agree to the Terms, incl. individual arbitration and class waiver", value: "agreed" }] } });

/** The consent fields a session is created with (terms checkbox on). */
export function withTermsConsent(params, baseUrl) {
  return {
    ...params,
    consent_collection: { ...(params.consent_collection || {}), terms_of_service: "required" },
    custom_text: { ...(params.custom_text || {}), terms_of_service_acceptance: { message: termsAcceptanceMessage(baseUrl).slice(0, 1200) } },
  };
}

/** The same session with the terms checkbox replaced by a required dropdown. */
export function withTermsDropdown(params) {
  const { consent_collection: cc, ...rest } = params;
  const consent = { ...(cc || {}) };
  delete consent.terms_of_service;
  const ct = { ...(rest.custom_text || {}) };
  delete ct.terms_of_service_acceptance;
  const fields = [...(rest.custom_fields || [])].filter((f) => f.key !== "terms");
  return { ...rest, ...(Object.keys(consent).length ? { consent_collection: consent } : {}), custom_text: ct, custom_fields: [TERMS_DROPDOWN, ...fields].slice(0, 3) };
}

/** Stripe's refusal of a terms checkbox on an account with no Terms URL set. */
export function isTermsUrlRefusal(err) {
  const m = String(err?.message || err?.raw?.message || "");
  return /terms of service/i.test(m) && /(url|public details|dashboard|business settings)/i.test(m);
}

let fallbackLogged = false;
/** Create the session with the terms checkbox; on Stripe's Terms-URL refusal, with the required dropdown. */
export async function createWithConsent(stripe, params, baseUrl, { log = console.error } = {}) {
  try {
    return await stripe.checkout.sessions.create(withTermsConsent(params, baseUrl));
  } catch (e) {
    if (!isTermsUrlRefusal(e)) throw e;
    if (!fallbackLogged) { fallbackLogged = true; log("[checkout] Stripe refused the Terms of Service checkbox (no Terms URL in the account's public details); using the required terms dropdown instead. Set the Terms URL in the Stripe dashboard."); }
    return stripe.checkout.sessions.create(withTermsDropdown(params));
  }
}

/** The value a completed session holds for one of its custom fields, or null. */
export function customFieldValue(session, key) {
  const f = (Array.isArray(session?.custom_fields) ? session.custom_fields : []).find((x) => x?.key === key);
  return f?.dropdown?.value ?? f?.text?.value ?? null;
}

/** True when the report buyer turned the follow-up emails off at checkout. */
export function followupsOptedOut(session) {
  return customFieldValue(session, "followups") === "no";
}

/** The consent a completed session recorded: kept with the subscription or sale. */
export function consentRecordOf(session, { priceCents = null } = {}) {
  const terms = session?.consent?.terms_of_service === "accepted" || customFieldValue(session, "terms") === "agreed" ? "accepted" : null;
  const autoRenew = customFieldValue(session, "autorenew") === "agreed" ? "agreed" : null;
  return { terms, ...(autoRenew ? { autoRenew, autoRenewPriceCents: Number.isFinite(Number(priceCents)) ? Number(priceCents) : null } : {}), at: new Date((Number(session?.created) || Math.floor(Date.now() / 1000)) * 1000).toISOString(), session: typeof session?.id === "string" ? session.id : null };
}
