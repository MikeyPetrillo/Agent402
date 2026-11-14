// The response content type of a catalog tool, read from ONE pair of fields on
// its definition so every surface that states it agrees:
//   - `mimeType`: the content type the tool's published example answers with.
//     The x402 listing (resource.mimeType), the first /openapi.json 200
//     content entry and the /api/pricing row all read it. Absent = JSON.
//   - `binaryTypes`: every raw-bytes content type the tool can answer with
//     (the route binder's { __binary, contentType } sentinel), when it depends
//     on an input such as `format`. A tool that answers one binary type may
//     declare `mimeType` alone.
//   - `legacyListingExample`: the sample output the x402 listing carried
//     before it named its bytes; listed only when X402_BINARY_LISTINGS=off.
// A tool whose handler returns { __binary } declares one or both; the listing
// sweep (scripts/test-bazaar-contracts.js) holds every 402 to them and the
// strict example sweep (scripts/test-non-metered-examples.js) holds the live
// answer to them.

export const JSON_MIME = "application/json";

/** Content types a tool answers with as raw bytes, or null for a JSON tool. */
export function binaryTypesOf(tool) {
  if (Array.isArray(tool?.binaryTypes) && tool.binaryTypes.length) return tool.binaryTypes;
  if (typeof tool?.mimeType === "string" && tool.mimeType && tool.mimeType !== JSON_MIME) return [tool.mimeType];
  return null;
}

/** The content type the tool's published example answers with. */
export function listingMimeTypeOf(tool) {
  return typeof tool?.mimeType === "string" && tool.mimeType ? tool.mimeType : JSON_MIME;
}

/** True when the published example answers raw bytes, not JSON. */
export function isBinaryListing(tool) {
  return listingMimeTypeOf(tool) !== JSON_MIME;
}

/** Every content type a 200 can carry, the listing type first. */
export function responseTypesOf(tool) {
  return [...new Set([listingMimeTypeOf(tool), ...(binaryTypesOf(tool) || [])])];
}

/** The sample output a binary listing carries in place of a JSON body: a
 *  string naming the bytes, never an object a buyer could take for the
 *  answer's shape. */
export function binaryOutputExample(tool) {
  const mime = listingMimeTypeOf(tool);
  const others = responseTypesOf(tool).filter((t) => t !== mime && t !== JSON_MIME);
  return `(raw ${mime} bytes, not JSON${others.length ? `; other formats answer ${others.join(", ")}` : ""})`;
}

/** Rollout switch for the x402 listing only (the 402's PAYMENT-REQUIRED
 *  header, its mirrored body and the discovery extension in them). Default
 *  (unset, or any value but "off"): a binary route lists its content type,
 *  output type "binary" and a string sample naming its bytes.
 *  X402_BINARY_LISTINGS=off: every route lists exactly what it listed before
 *  that, which is mimeType application/json, output type "json" and the
 *  tool's earlier sample (its def's `legacyListingExample`) with the schema
 *  derived from it. /openapi.json's content types, the /api/pricing rows and
 *  the tool pages do not read the switch. src/payments.js reads it once, when
 *  the payment middleware is built, so a flip takes effect on restart. */
export function binaryListingsEnabled(env = process.env) {
  return String(env.X402_BINARY_LISTINGS || "").toLowerCase() !== "off";
}

/** The Bazaar declaration's output.type for a binary listing. The extension's
 *  own schema types it as any string (no enum) and its declare helper writes
 *  "json" whatever it is handed, so the value is set on the declared block. */
export const BINARY_OUTPUT_TYPE = "binary";
export function withBinaryOutputType(declared) {
  const output = declared?.bazaar?.info?.output;
  if (output) output.type = BINARY_OUTPUT_TYPE;
  return declared;
}

/** The typed schema for that sample: a string carrying the media type. */
export function binaryOutputSchema(tool) {
  return { type: "string", contentMediaType: listingMimeTypeOf(tool) };
}
