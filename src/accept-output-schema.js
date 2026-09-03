// `accepts[0].outputSchema` on our own 402: the x402 v2 field a buyer reads at
// the moment of deciding to pay, carrying the SAME bounded typed schema the
// Bazaar discovery extension already carries (boundedSchemaFromExample,
// 2026-08-29) - one copy, on the first accept only.
//
// Why one copy: a buyer echoes the whole chosen accept back inside its payment
// payload, so thirteen rails x ~400 bytes of schema is structurally
// unaffordable; the first accept (Base, the rail every stock client takes
// first) is where the field earns its bytes. Measured 2026-09-02 on prod's
// widest sampled challenge (11,108 bytes, the nano chat route): +~540 bytes
// stays under the 12,000-byte ceiling test-challenge-size enforces.
//
// WHY A PROTOTYPE PATCH AND NOT A HEADER REWRITE (the first draft, 2026-09-02,
// failed CI's "an unmodified x402 client settles" control): @x402/core builds
// ONE requirements list per request from the route's accepts
// (buildPaymentRequirementsFromOptions), serialises it into the 402 AND
// deep-equals the buyer's echoed `accepted` against it at verify time
// (paymentRequirementsMatchAccepted: every field but `extra` must match). A
// field added only to the outgoing header is therefore a field the buyer
// echoes back and the server has never seen - every honest payment fails
// "no matching requirements". The builder copies exactly scheme, payTo,
// price, network, maxTimeoutSeconds and extra from an accept, so the field
// cannot be declared on the route either. So: the accept DECLARES it
// (withOutputSchemaOnFirstAccept, payments.js), and this patch stamps it onto
// the requirement the core built from that accept - the object that becomes
// the 402 and the object verify compares against, the same one. Same
// prototype seam as the facilitator patches (rpc-timeout, settle-poll,
// fee-bid). PaymentRequirementsSchema admits `outputSchema`
// (Any.optional().nullable()), so the buyer's parsed accept keeps it and the
// MPP shim, which carries the accept verbatim, round-trips it byte-exact.
//
// STRICT CLIENT CODECS (found the same day by test-mpp-shim's plain x402 buy):
// mppx's x402 client protocol parses each accept through its own eip155-typed
// zod schema, which strips every field it does not declare, and echoes THAT -
// so a buyer built on it would be refused "no matching requirements" on the
// one accept carrying the field. The advertised field is ours, the buyer's
// signature covers the EIP-3009 authorization and never the echoed accept, so
// the match seam is made tolerant instead: when nothing matches and the
// echoed accept carries NO outputSchema, the schema we advertised for that
// scheme + network is restored onto it and the match runs again. Every other
// field still has to be byte-exact (a different amount or payTo stays
// refused), and an accept carrying a DIFFERENT outputSchema is never
// overwritten. Rollout switch: ACCEPT_OUTPUT_SCHEMA=off stops declaring the
// field (a facilitator that refuses it on /verify is one flag away; the
// daily paid canary on Base is the live proof that CDP does not).
const PATCHED = Symbol.for("agent402.acceptOutputSchema");

export function acceptOutputSchemaEnabled(env = process.env) {
  return String(env.ACCEPT_OUTPUT_SCHEMA || "").toLowerCase() !== "off";
}

const isSchema = (s) => !!s && typeof s === "object" && !Array.isArray(s);

/** The bazaar extension's typed output schema (where declareDiscoveryExtension puts it), or null. */
export function outputSchemaFromExtensions(ext) {
  const s = ext?.bazaar?.schema?.properties?.output?.properties?.example;
  return isSchema(s) ? s : null;
}

/** Pure: a copy of `accepts` whose FIRST entry declares `outputSchema` (unchanged when there is nothing to add). */
export function withOutputSchemaOnFirstAccept(accepts, schema) {
  if (!Array.isArray(accepts) || !accepts.length || !isSchema(schema)) return accepts;
  if (accepts[0].outputSchema !== undefined) return accepts;
  return [{ ...accepts[0], outputSchema: schema }, ...accepts.slice(1)];
}

/**
 * Pure: stamp the first declaring option's schema onto the first requirement
 * built from it (same scheme + network), in place. Returns `requirements`.
 * Exactly one copy; nothing invented when no option declares one; a
 * requirement that already carries one is left alone.
 */
export function stampOutputSchema(paymentOptions, requirements) {
  if (!Array.isArray(paymentOptions) || !Array.isArray(requirements)) return requirements;
  const option = paymentOptions.find((o) => o && isSchema(o.outputSchema));
  if (!option) return requirements;
  const target = requirements.find((r) => r && r.scheme === option.scheme && r.network === option.network);
  if (!target || target.outputSchema !== undefined) return requirements;
  target.outputSchema = option.outputSchema;
  return requirements;
}

/**
 * Pure: when a v2 payload's echoed accept carries NO outputSchema and a
 * requirement with its scheme + network advertises one, restore ours onto the
 * accept (in place). Returns true when it restored. Never overwrites a value
 * the buyer sent, never touches v1 payloads, never invents a schema.
 */
export function restoreOutputSchemaOnAccepted(requirements, paymentPayload) {
  const accepted = paymentPayload?.accepted;
  if (paymentPayload?.x402Version !== 2 || !accepted || typeof accepted !== "object") return false;
  if (accepted.outputSchema !== undefined) return false;
  if (!Array.isArray(requirements)) return false;
  const req = requirements.find((r) => r && isSchema(r.outputSchema) && r.scheme === accepted.scheme && r.network === accepted.network);
  if (!req) return false;
  accepted.outputSchema = req.outputSchema;
  return true;
}

/** Install once on the resource server class (idempotent). Returns true when it patched. */
export function installAcceptOutputSchema(ResourceServerClass) {
  const proto = ResourceServerClass?.prototype;
  if (!proto || typeof proto.buildPaymentRequirementsFromOptions !== "function" || typeof proto.findMatchingRequirements !== "function") return false;
  if (proto.buildPaymentRequirementsFromOptions[PATCHED]) return false;
  const origBuild = proto.buildPaymentRequirementsFromOptions;
  const build = async function buildPaymentRequirementsFromOptions(paymentOptions, context) {
    const requirements = await origBuild.call(this, paymentOptions, context);
    try { stampOutputSchema(paymentOptions, requirements); } catch { /* the pre-2026-09-02 shape, never a failed 402 */ }
    return requirements;
  };
  build[PATCHED] = true;
  proto.buildPaymentRequirementsFromOptions = build;
  const origFind = proto.findMatchingRequirements;
  const find = function findMatchingRequirements(availableRequirements, paymentPayload) {
    const found = origFind.call(this, availableRequirements, paymentPayload);
    if (found) return found;
    let restored = false;
    try { restored = restoreOutputSchemaOnAccepted(availableRequirements, paymentPayload); } catch { restored = false; }
    return restored ? origFind.call(this, availableRequirements, paymentPayload) : found;
  };
  find[PATCHED] = true;
  proto.findMatchingRequirements = find;
  return true;
}
