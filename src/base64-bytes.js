/**
 * The bytes an encoded transaction field stands for, read the way the
 * facilitators read it. Node's base64 decoder (which @x402/avm and the
 * Stellar XDR reader use) skips every character outside the alphabet, reads
 * "-" and "_" as "+" and "/", stops at the first "=", and reads each UTF-16
 * code unit by its low byte; @solana/kit's decoder accepts a subset of those
 * spellings and yields the same bytes for each. So many texts spell one
 * transaction, and only the decoded bytes are its identity: a size cap, a hash
 * or a decode is applied to these bytes, never to the text's own length or
 * characters.
 */

/**
 * The decoded bytes of `text`, or null when it is not a non-empty string or
 * decodes to nothing. `maxBytes` is not applied here: a caller decides what an
 * over-size transaction means, measured on the bytes this returns.
 * @param {unknown} text
 * @returns {Buffer|null}
 */
export function base64BytesOf(text) {
  if (typeof text !== "string" || !text) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.length ? bytes : null;
}
