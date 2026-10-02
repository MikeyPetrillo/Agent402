// Read a response body that someone else wrote, and stop at a byte cap.
//
// Every body the router, the payability check and the crawler read from a
// seller (or from a URL a caller chose) is third-party bytes of unknown size.
// The rule here: pull the stream one chunk at a time, keep at most `maxBytes`,
// and cancel the stream the moment the cap is passed. Memory held is the cap
// plus one transport chunk, whatever the far side sends, and a size rule runs
// while the body arrives rather than after it has all arrived. The connection
// pinning (the SSRF dispatcher the caller fetched with) is untouched: this
// only changes how the body is read.
//
// An object with no `body` stream at all is not a fetch Response (an injected
// test stub); its own text() is the only thing there is to read, and it is
// capped the same way after the fact.

/** Content-Length as a number, or null when absent or unreadable. */
export function declaredLength(res) {
  try {
    const raw = res?.headers?.get?.("content-length");
    if (raw == null || String(raw).trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/** Stop reading and release the connection without waiting on the far side. */
export function discardBody(res) {
  try {
    const b = res?.body;
    if (b && typeof b.cancel === "function") b.cancel().catch(() => {});
    else if (b && typeof b.destroy === "function") b.destroy();
  } catch { /* already consumed or locked: nothing to release */ }
}

/**
 * Read at most `maxBytes` of a response body.
 * Returns `{ bytes: Buffer, truncated: boolean }`. `truncated` means the body
 * had more than `maxBytes`; the rest was never read. A stream error (a timeout
 * or reset mid-body) rejects, as `text()` would.
 */
export async function readBytesCapped(res, maxBytes) {
  const cap = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const body = res?.body;
  const chunks = [];
  let got = 0;
  let truncated = false;
  const take = (value) => {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const room = cap - got;
    if (buf.length > room) {
      if (room > 0) { chunks.push(buf.subarray(0, room)); got += room; }
      truncated = true;
      return false;
    }
    chunks.push(buf);
    got += buf.length;
    return true;
  };
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !take(value)) break;
      }
    } finally {
      if (truncated) reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* a pending read after cancel: the lock goes with the stream */ }
    }
    return { bytes: Buffer.concat(chunks, got), truncated };
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const value of body) {
      if (value && !take(typeof value === "string" ? Buffer.from(value, "utf8") : value)) break;
    }
    if (truncated) { try { body.destroy?.(); } catch { /* gone */ } }
    return { bytes: Buffer.concat(chunks, got), truncated };
  }
  if (body === null) return { bytes: Buffer.alloc(0), truncated: false };
  if (res && typeof res.text === "function") {
    const all = Buffer.from(String(await res.text()), "utf8");
    return all.length > cap ? { bytes: all.subarray(0, cap), truncated: true } : { bytes: all, truncated: false };
  }
  return { bytes: Buffer.alloc(0), truncated: false };
}

// Bytes become text the way Response.text() makes them: UTF-8, a leading
// byte-order mark dropped, a malformed or split sequence read as U+FFFD. A
// seller whose JSON opens with a BOM parses here exactly as it does through
// text() or json().
const UTF8 = new TextDecoder("utf-8");
export function decodeUtf8(bytes) {
  return UTF8.decode(bytes);
}

/** The first `maxBytes` of a body as text, decoded as Response.text() decodes. */
export async function readTextCapped(res, maxBytes) {
  return decodeUtf8((await readBytesCapped(res, maxBytes)).bytes);
}
