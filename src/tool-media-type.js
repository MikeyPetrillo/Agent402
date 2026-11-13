// The response content type of a catalog tool, read from ONE pair of fields on
// its definition so every surface that states it agrees:
//   - `mimeType`: the content type the tool's published example answers with.
//     The x402 listing (resource.mimeType), the first /openapi.json 200
//     content entry and the /api/pricing row all read it. Absent = JSON.
//   - `binaryTypes`: every raw-bytes content type the tool can answer with
//     (the route binder's { __binary, contentType } sentinel), when it depends
//     on an input such as `format`. A tool that answers one binary type may
//     declare `mimeType` alone.
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

/** The typed schema for that sample: a string carrying the media type. */
export function binaryOutputSchema(tool) {
  return { type: "string", contentMediaType: listingMimeTypeOf(tool) };
}
