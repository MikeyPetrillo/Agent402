// A small RFC 5322 / MIME reader for email-guard (./email-guard-kit.js): one
// message string in, its headers and text parts out. Plain data only, no
// dependencies, no network.
//
// What it reads: folded headers, encoded words (RFC 2047, B and Q), the
// Content-Type parameters (boundary, charset, name), Content-Disposition
// (attachment, filename), base64 and quoted-printable transfer encodings,
// text/plain and text/html bodies, and every multipart/* container (the
// alternative, mixed and related forms all nest the same way). Each part
// records whether it was decoded; a part it could not decode (an unsupported
// transfer encoding or charset, a container without a boundary, nesting past
// the depth cap) is listed with the reason, so the caller can mark the answer
// partial instead of reading an empty part as a clean one.

export const MAX_RAW_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_PARTS = 64;
const MAX_HEADER_LINES = 500;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const HEADER_LINE = /^([!-9;-~]+):[ \t]*(.*)$/;

/** Split a header block into [{ name, value }] with folded lines joined. */
function parseHeaderBlock(block) {
  const out = [];
  const lines = block.split("\n");
  let current = null;
  for (const line of lines) {
    if (out.length > MAX_HEADER_LINES) break;
    if (/^[ \t]/.test(line) && current) { current.value += " " + line.trim(); continue; }
    const m = line.match(HEADER_LINE);
    if (!m) { current = null; continue; }
    current = { name: m[1].toLowerCase(), value: m[2] };
    out.push(current);
  }
  return out;
}

const headerOf = (headers, name) => headers.find((h) => h.name === name)?.value ?? null;

/** Decode bytes in a named charset. Throws when the charset is unknown. */
function decodeBytes(buf, charset) {
  const cs = String(charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  const name = cs === "us-ascii" || cs === "ascii" || cs === "utf8" ? "utf-8" : cs;
  const dec = new TextDecoder(name); // RangeError on an unsupported label
  return dec.decode(buf);
}

function decodeQuotedPrintable(s) {
  const bytes = [];
  const src = String(s).replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) { bytes.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words in a header value: =?charset?B?...?= and =?charset?Q?...?=.
 *  Adjacent encoded words separated only by whitespace join without the space. */
export function decodeEncodedWords(value) {
  const s = String(value ?? "");
  if (!s.includes("=?")) return s;
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=(?:\s+(?==\?))?/g, (m, charset, enc, text) => {
    try {
      const buf = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeBytes(buf, charset);
    } catch { return m; }
  });
}

/** "type/subtype; a=b; c=\"d e\"" -> { type, params } with lowercase names. */
export function parseContentType(value) {
  const s = String(value ?? "").trim();
  if (!s) return { type: "", params: {} };
  const [head, ...rest] = s.split(";");
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    // RFC 2231: name*=charset'lang'percent-encoded (one segment is enough here).
    if (name.endsWith("*")) {
      name = name.slice(0, -1);
      const m = val.match(/^([^']*)'[^']*'(.*)$/);
      if (m) { try { val = decodeBytes(Buffer.from(m[2].replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), "latin1"), m[1] || "utf-8"); } catch { val = m[2]; } }
    }
    if (!(name in params)) params[name] = val;
  }
  return { type: head.trim().toLowerCase(), params };
}

/** Body text of one leaf part, decoded by its transfer encoding and charset.
 *  Returns { text } or { reason } when it cannot be decoded. */
function decodeLeaf(body, encoding, charset) {
  const enc = String(encoding || "7bit").trim().toLowerCase();
  try {
    if (enc === "base64") return { text: decodeBytes(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"), charset) };
    if (enc === "quoted-printable") return { text: decodeBytes(decodeQuotedPrintable(body), charset) };
    // The message arrived as a string already, so an unencoded body is its text as given.
    if (enc === "7bit" || enc === "8bit" || enc === "binary" || enc === "") return { text: body };
    return { reason: `unsupported transfer encoding "${enc}"` };
  } catch {
    return { reason: `unsupported charset "${String(charset).slice(0, 40)}"` };
  }
}

/** Split a multipart body on its boundary. Returns the part strings, or null
 *  when the boundary delimits nothing. */
function splitMultipart(body, boundary) {
  const delim = "--" + boundary;
  const lines = body.split("\n");
  const parts = [];
  let current = null;
  for (const line of lines) {
    const l = line.replace(/\r$/, "");
    if (l === delim || l.startsWith(delim + " ")) { if (current) parts.push(current.join("\n")); current = []; continue; }
    if (l === delim + "--" || l.startsWith(delim + "-- ")) { if (current) parts.push(current.join("\n")); current = null; break; }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join("\n")); // no closing delimiter: keep what was read
  return parts.length ? parts : null;
}

/**
 * Parse one RFC 5322 message. Returns:
 *   headers:  [{ name, value }] (names lowercase, values with encoded words decoded)
 *   subject, from, replyTo, to, date, messageId: header values or null
 *   text:     the text/plain parts joined, or null
 *   html:     the text/html parts joined, or null
 *   parts:    [{ index, contentType, charset, encoding, disposition, filename, bytes, role, decoded, reason? }]
 *   attachments: the parts that are neither a container nor a text body
 *   undecoded: the parts that could not be decoded (with reasons)
 */
export function parseMessage(raw) {
  if (typeof raw !== "string") throw bad('"raw" must be the message as a string');
  if (Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES) throw bad(`"raw" is capped at ${MAX_RAW_BYTES} bytes`, 413);
  const src = raw.replace(/\r\n/g, "\n");
  if (!src.trim()) throw bad('"raw" is empty');
  if (!HEADER_LINE.test(src.split("\n", 1)[0])) throw bad('"raw" does not start with a header line (Name: value), so it is not an RFC 5322 message');

  const parts = [];
  const texts = [];
  const htmls = [];
  const notes = [];
  let truncatedParts = false;

  function walk(section, depth, inherited) {
    if (parts.length >= MAX_PARTS) { truncatedParts = true; return; }
    const sep = section.indexOf("\n\n");
    const headerBlock = sep >= 0 ? section.slice(0, sep) : (section.startsWith("\n") ? "" : section);
    const body = sep >= 0 ? section.slice(sep + 2) : (section.startsWith("\n") ? section.slice(1) : "");
    const headers = parseHeaderBlock(headerBlock);
    const ct = parseContentType(headerOf(headers, "content-type") || inherited || "text/plain");
    const cd = parseContentType(headerOf(headers, "content-disposition") || "");
    const encoding = (headerOf(headers, "content-transfer-encoding") || "7bit").trim().toLowerCase();
    const filename = decodeEncodedWords(cd.params.filename || ct.params.name || "") || null;
    const part = {
      index: parts.length,
      depth,
      contentType: ct.type || "text/plain",
      charset: ct.params.charset || null,
      encoding,
      disposition: cd.type || null,
      filename,
      bytes: Buffer.byteLength(body, "utf8"),
      role: "attachment",
      decoded: true,
    };
    parts.push(part);
    const isMultipart = part.contentType.startsWith("multipart/");
    if (isMultipart) {
      part.role = "container";
      if (depth >= MAX_DEPTH) { part.decoded = false; part.reason = `nested deeper than ${MAX_DEPTH} levels`; return; }
      const boundary = ct.params.boundary;
      if (!boundary) { part.decoded = false; part.reason = "multipart container without a boundary parameter"; return; }
      const children = splitMultipart(body, boundary);
      if (!children) { part.decoded = false; part.reason = "no part delimited by the declared boundary"; return; }
      const inheritedType = part.contentType === "multipart/digest" ? "message/rfc822" : null;
      for (const child of children) walk(child, depth + 1, inheritedType);
      return;
    }
    const isText = part.contentType === "text/plain" || part.contentType === "text/html";
    if (!isText || cd.type === "attachment") {
      // Attachments are listed, never decoded: their bytes are not mail text.
      part.role = "attachment";
      return;
    }
    part.role = part.contentType === "text/html" ? "html" : "text";
    const dec = decodeLeaf(body, encoding, part.charset);
    if (dec.reason) { part.decoded = false; part.reason = dec.reason; return; }
    (part.role === "html" ? htmls : texts).push(dec.text);
  }

  walk(src, 0, null);
  if (truncatedParts) notes.push(`only the first ${MAX_PARTS} parts were read`);

  const top = parseHeaderBlock(src.slice(0, src.indexOf("\n\n") >= 0 ? src.indexOf("\n\n") : src.length));
  const h = (name) => { const v = headerOf(top, name); return v === null ? null : decodeEncodedWords(v).trim(); };
  return {
    headers: top.map((x) => ({ name: x.name, value: decodeEncodedWords(x.value) })),
    subject: h("subject"),
    from: h("from"),
    replyTo: h("reply-to"),
    to: h("to"),
    date: h("date"),
    messageId: h("message-id"),
    text: texts.length ? texts.join("\n\n") : null,
    html: htmls.length ? htmls.join("\n") : null,
    parts,
    attachments: parts.filter((p) => p.role === "attachment").map((p) => ({ index: p.index, contentType: p.contentType, filename: p.filename, bytes: p.bytes, disposition: p.disposition })),
    undecoded: parts.filter((p) => !p.decoded).map((p) => ({ index: p.index, contentType: p.contentType, reason: p.reason })),
    notes,
  };
}

/** One mailbox: "Name" <addr@host>, Name <addr@host>, <addr@host> or addr@host. */
export function parseMailbox(raw) {
  const s = decodeEncodedWords(String(raw ?? "")).trim();
  if (!s) return null;
  const first = s.split(",")[0].trim();
  let displayName = null;
  let address = null;
  const m = first.match(/^(.*?)\s*<([^<>]*)>\s*$/s);
  if (m) {
    displayName = m[1].trim().replace(/^"(.*)"$/s, "$1").trim() || null;
    address = m[2].trim();
  } else {
    const a = first.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
    address = a ? a[0] : null;
    if (a && first.replace(a[0], "").trim()) displayName = first.replace(a[0], "").replace(/^"(.*)"$/s, "$1").trim() || null;
  }
  const at = address ? address.lastIndexOf("@") : -1;
  const domain = at > 0 ? address.slice(at + 1).toLowerCase().replace(/[.\s]+$/, "") : null;
  return { raw: s, displayName, address: address ? address.toLowerCase() : null, domain };
}
