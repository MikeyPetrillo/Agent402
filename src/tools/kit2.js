// Kit 2 — 36 more pure-CPU tools (free via proof-of-work) taking the catalog to
// 100. All deterministic, no network, ~zero cost to serve, and each covered by
// an exact-output test in scripts/test-kit2.js.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
function need(input, field, type = "string") {
  const v = input[field];
  if (v === undefined || v === null || (type === "string" && typeof v !== "string")) throw bad(`Missing or invalid "${field}"`);
  return v;
}
function cap(text, max = 100_000, label = "text") {
  if (typeof text !== "string") throw bad(`"${label}" must be a string`);
  if (text.length > max) throw bad(`"${label}" exceeds ${max} characters`);
  return text;
}
const numArray = (v, label = "numbers") => {
  let arr = v;
  if (typeof v === "string") {
    try { arr = JSON.parse(v); } catch { throw bad(`"${label}" must be a JSON array of numbers`); }
  }
  if (!Array.isArray(arr) || !arr.length) throw bad(`"${label}" must be a non-empty array`);
  const nums = arr.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) throw bad(`"${label}" must contain only numbers`);
  return nums;
};
const parseMaybeJson = (v, label) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    throw bad(`"${label}" is not valid JSON: ${e.message}`);
  }
};

// ===========================================================================
// Encoding
// ===========================================================================

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(buf) {
  let x = 0n;
  for (const b of buf) x = x * 256n + BigInt(b);
  let out = "";
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}
function base58decode(str) {
  let x = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw bad(`Invalid base58 character: ${ch}`);
    x = x * 58n + BigInt(i);
  }
  const bytes = [];
  while (x > 0n) {
    bytes.unshift(Number(x % 256n));
    x /= 256n;
  }
  for (const ch of str) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

const B32A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32A[(value << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}
function base32decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32A.indexOf(ch);
    if (idx < 0) throw bad(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(str) {
  let c = 0xffffffff;
  const buf = Buffer.from(str, "utf8");
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const MORSE = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
  K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
  U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..", 0: "-----", 1: ".----", 2: "..---",
  3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.", ".": ".-.-.-",
  ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-",
  "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-",
  '"': ".-..-.", $: "...-..-", "@": ".--.-.",
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

const HTML_ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_ENT_REV = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", copy: "©", reg: "®" };

const encoding = [
  {
    route: "POST /api/base58", name: "Base58", slug: "base58", category: "encoding", price: "$0.001",
    description: "Base58 encode or decode text (Bitcoin/IPFS alphabet). mode: encode (default) or decode.",
    tags: ["base58", "encode", "decode", "crypto"],
    discovery: { bodyType: "json", input: { text: "Hello", mode: "encode" }, inputSchema: { properties: { text: { type: "string" }, mode: { type: "string", description: "encode | decode" } }, required: ["text"] }, output: { example: { mode: "encode", result: "9Ajdvzr" } } },
    handler: (i) => {
      const text = cap(need(i, "text"));
      return i.mode === "decode"
        ? { mode: "decode", result: base58decode(text).toString("utf8") }
        : { mode: "encode", result: base58encode(Buffer.from(text, "utf8")) };
    },
  },
  {
    route: "POST /api/base32", name: "Base32", slug: "base32", category: "encoding", price: "$0.001",
    description: "Base32 (RFC 4648) encode or decode text. mode: encode (default) or decode.",
    tags: ["base32", "encode", "decode"],
    discovery: { bodyType: "json", input: { text: "hello", mode: "encode" }, inputSchema: { properties: { text: { type: "string" }, mode: { type: "string", description: "encode | decode" } }, required: ["text"] }, output: { example: { mode: "encode", result: "NBSWY3DP" } } },
    handler: (i) => {
      const text = cap(need(i, "text"));
      return i.mode === "decode"
        ? { mode: "decode", result: base32decode(text).toString("utf8") }
        : { mode: "encode", result: base32encode(Buffer.from(text, "utf8")) };
    },
  },
  {
    route: "POST /api/crc32", name: "CRC32", slug: "crc32", category: "encoding", price: "$0.001",
    description: "CRC-32 checksum of a text string (hex), the IEEE polynomial used by zip/png/gzip.",
    tags: ["crc32", "checksum", "hash"],
    discovery: { bodyType: "json", input: { text: "hello world" }, inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, output: { example: { hex: "0d4a1185", uint: 222957957 } } },
    handler: (i) => {
      const hex = crc32(cap(need(i, "text")));
      return { hex, uint: parseInt(hex, 16) };
    },
  },
  {
    route: "POST /api/rot13", name: "ROT13 / Caesar", slug: "rot13", category: "encoding", price: "$0.001",
    description: "Caesar-cipher a string. Default shift 13 (ROT13, self-inverse). Set shift for any rotation 1-25.",
    tags: ["rot13", "caesar", "cipher"],
    discovery: { bodyType: "json", input: { text: "Hello", shift: 13 }, inputSchema: { properties: { text: { type: "string" }, shift: { type: "number", description: "1-25 (default 13)" } }, required: ["text"] }, output: { example: { result: "Uryyb" } } },
    handler: (i) => {
      const text = cap(need(i, "text"));
      let s = i.shift === undefined ? 13 : parseInt(i.shift, 10);
      if (!Number.isFinite(s)) throw bad('"shift" must be a number');
      s = ((s % 26) + 26) % 26;
      return {
        result: text.replace(/[a-z]/gi, (c) => {
          const base = c <= "Z" ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - base + s) % 26) + base);
        }),
      };
    },
  },
  {
    route: "POST /api/morse", name: "Morse code", slug: "morse", category: "encoding", price: "$0.001",
    description: "Encode text to Morse code or decode it back. mode: encode (default) or decode. Words separated by ' / '.",
    tags: ["morse", "encode", "decode"],
    discovery: { bodyType: "json", input: { text: "SOS", mode: "encode" }, inputSchema: { properties: { text: { type: "string" }, mode: { type: "string", description: "encode | decode" } }, required: ["text"] }, output: { example: { mode: "encode", result: "... --- ..." } } },
    handler: (i) => {
      const text = cap(need(i, "text"), 5000);
      if (i.mode === "decode") {
        const result = text.trim().split(/\s*\/\s*/).map((w) => w.trim().split(/\s+/).map((c) => MORSE_REV[c] ?? "").join("")).join(" ");
        return { mode: "decode", result };
      }
      const result = text.toUpperCase().split(/\s+/).map((w) => [...w].map((c) => MORSE[c] ?? "").filter(Boolean).join(" ")).join(" / ");
      return { mode: "encode", result };
    },
  },
  {
    route: "POST /api/html-entities", name: "HTML entities", slug: "html-entities", category: "encoding", price: "$0.001",
    description: "Encode text to HTML entities or decode them back. mode: encode (default) or decode.",
    tags: ["html", "entities", "encode", "decode", "escape"],
    discovery: { bodyType: "json", input: { text: "<a href=\"x\">", mode: "encode" }, inputSchema: { properties: { text: { type: "string" }, mode: { type: "string", description: "encode | decode" } }, required: ["text"] }, output: { example: { mode: "encode", result: "&lt;a href=&quot;x&quot;&gt;" } } },
    handler: (i) => {
      const text = cap(need(i, "text"));
      if (i.mode === "decode") {
        const result = text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
          if (e[0] === "#") {
            const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
          }
          return HTML_ENT_REV[e] ?? HTML_ENT_REV[e.toLowerCase()] ?? m;
        });
        return { mode: "decode", result };
      }
      return { mode: "encode", result: text.replace(/[&<>"']/g, (c) => HTML_ENT[c]) };
    },
  },
  {
    route: "POST /api/jwt-verify", name: "JWT verify (HMAC)", slug: "jwt-verify", category: "encoding", price: "$0.002",
    description: "Verify an HS256/384/512 JWT signature against a secret and check expiry. Returns valid + decoded payload. (HMAC algorithms only.)",
    tags: ["jwt", "verify", "hmac", "auth"],
    discovery: { bodyType: "json", input: { token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudDQwMiIsIm5hbWUiOiJkZW1vIGFnZW50IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjk5OTk5OTk5OTl9.NqggPBGuLX1OA7YuSlQ4S0INJfCOWnwXWT0XUIUrt3s", secret: "my-secret" }, inputSchema: { properties: { token: { type: "string" }, secret: { type: "string" } }, required: ["token", "secret"] }, output: { example: { valid: true, algorithm: "HS256", expired: false, payload: { sub: "agent402" } } } },
    handler: (i) => {
      const token = cap(need(i, "token"), 16384, "token");
      const secret = need(i, "secret");
      const parts = token.split(".");
      if (parts.length !== 3) throw bad("Not a signed JWT (expected 3 segments)");
      let header;
      try {
        header = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      } catch {
        throw bad("Invalid JWT header");
      }
      const algMap = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
      const algo = algMap[header.alg];
      if (!algo) return { valid: false, reason: `Unsupported alg "${header.alg}" (HMAC only)` };
      const expected = createHmac(algo, secret).update(`${parts[0]}.${parts[1]}`).digest();
      const given = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const valid = expected.length === given.length && timingSafeEqual(expected, given);
      let payload = {};
      try {
        payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      } catch {}
      const nowS = Math.floor(Date.now() / 1000);
      return { valid, algorithm: header.alg, expired: typeof payload.exp === "number" ? payload.exp < nowS : null, payload };
    },
  },
];

// ===========================================================================
// Text
// ===========================================================================

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function syllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return word.length ? 1 : 0;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

const text = [
  {
    route: "POST /api/count", name: "Count", slug: "count", category: "text", price: "$0.001",
    description: "Count characters, words, lines, and (optionally) occurrences of a substring in text.",
    tags: ["count", "occurrences", "text"],
    discovery: { bodyType: "json", input: { text: "the cat sat on the mat", find: "the" }, inputSchema: { properties: { text: { type: "string" }, find: { type: "string", description: "Optional substring to count" } }, required: ["text"] }, output: { example: { characters: 22, words: 6, lines: 1, occurrences: 2 } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 500_000);
      const out = { characters: t.length, words: (t.match(/\S+/g) || []).length, lines: t.split("\n").length };
      if (typeof i.find === "string" && i.find) {
        out.find = i.find;
        out.occurrences = t.split(i.find).length - 1;
      }
      return out;
    },
  },
  {
    route: "POST /api/truncate", name: "Truncate", slug: "truncate", category: "text", price: "$0.001",
    description: "Truncate text to a maximum length, adding an ellipsis (or custom suffix). Optionally break on word boundaries.",
    tags: ["truncate", "ellipsis", "text"],
    discovery: { bodyType: "json", input: { text: "The quick brown fox", length: 9, words: true }, inputSchema: { properties: { text: { type: "string" }, length: { type: "number" }, suffix: { type: "string", description: "Default …" }, words: { type: "boolean", description: "Break on whole words" } }, required: ["text", "length"] }, output: { example: { result: "The quick…", truncated: true } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 500_000);
      const len = parseInt(i.length, 10);
      if (!Number.isFinite(len) || len < 1) throw bad('"length" must be a positive integer');
      const suffix = typeof i.suffix === "string" ? i.suffix : "…";
      if (t.length <= len) return { result: t, truncated: false };
      let cut = t.slice(0, len);
      // Word mode: only trim a *partial* trailing word (i.e. the cut fell inside
      // a word — both sides of the boundary are non-whitespace).
      if ((i.words === true || i.words === "true") && /\S/.test(t[len] || "") && /\S/.test(cut.slice(-1))) {
        cut = cut.replace(/\S+$/, "").replace(/\s+$/, "");
      }
      return { result: cut + suffix, truncated: true };
    },
  },
  {
    route: "POST /api/sort-lines", name: "Sort lines", slug: "sort-lines", category: "text", price: "$0.001",
    description: "Sort the lines of a text. order: asc (default) | desc | numeric. unique:true removes duplicates; ci:true is case-insensitive.",
    tags: ["sort", "lines", "text"],
    discovery: { bodyType: "json", input: { text: "banana\napple\ncherry", order: "asc" }, inputSchema: { properties: { text: { type: "string" }, order: { type: "string", description: "asc | desc | numeric" }, unique: { type: "boolean" }, ci: { type: "boolean" } }, required: ["text"] }, output: { example: { result: "apple\nbanana\ncherry", lines: 3 } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 1_000_000);
      let lines = t.split("\n");
      if (i.unique === true || i.unique === "true") lines = [...new Set(lines)];
      const ci = i.ci === true || i.ci === "true";
      if (i.order === "numeric") lines.sort((a, b) => parseFloat(a) - parseFloat(b));
      else lines.sort((a, b) => (ci ? a.toLowerCase().localeCompare(b.toLowerCase()) : a.localeCompare(b)));
      if (i.order === "desc") lines.reverse();
      return { result: lines.join("\n"), lines: lines.length };
    },
  },
  {
    route: "POST /api/dedupe-lines", name: "Dedupe lines", slug: "dedupe-lines", category: "text", price: "$0.001",
    description: "Remove duplicate lines, preserving first-seen order. Returns the deduped text and how many were removed.",
    tags: ["dedupe", "unique", "lines", "text"],
    discovery: { bodyType: "json", input: { text: "a\nb\na\nc\nb" }, inputSchema: { properties: { text: { type: "string" }, ci: { type: "boolean", description: "Case-insensitive" } }, required: ["text"] }, output: { example: { result: "a\nb\nc", removed: 2, kept: 3 } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 1_000_000);
      const ci = i.ci === true || i.ci === "true";
      const seen = new Set();
      const out = [];
      for (const line of t.split("\n")) {
        const key = ci ? line.toLowerCase() : line;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(line);
        }
      }
      const total = t.split("\n").length;
      return { result: out.join("\n"), removed: total - out.length, kept: out.length };
    },
  },
  {
    route: "POST /api/levenshtein", name: "Edit distance", slug: "levenshtein", category: "text", price: "$0.001",
    description: "Levenshtein edit distance between two strings, plus a 0-1 similarity ratio.",
    tags: ["levenshtein", "edit-distance", "similarity", "fuzzy"],
    discovery: { bodyType: "json", input: { a: "kitten", b: "sitting" }, inputSchema: { properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] }, output: { example: { distance: 3, similarity: 0.571 } } },
    handler: (i) => {
      const a = cap(need(i, "a"), 10_000, "a");
      const b = cap(need(i, "b"), 10_000, "b");
      const d = levenshtein(a, b);
      const max = Math.max(a.length, b.length) || 1;
      return { distance: d, similarity: +(1 - d / max).toFixed(3) };
    },
  },
  {
    route: "POST /api/redact", name: "Redact PII", slug: "redact", category: "text", price: "$0.002",
    description: "Mask emails, phone numbers, credit-card-like numbers, IPs, and SSNs in text. Returns the redacted text and counts by type.",
    tags: ["redact", "pii", "mask", "privacy"],
    discovery: { bodyType: "json", input: { text: "reach me at ada@x.com or 555-123-4567" }, inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, output: { example: { result: "reach me at [EMAIL] or [PHONE]", counts: { email: 1, phone: 1 } } } },
    handler: (i) => {
      let t = cap(need(i, "text"), 500_000);
      const counts = {};
      const sub = (re, label) => {
        t = t.replace(re, () => {
          counts[label] = (counts[label] || 0) + 1;
          return `[${label.toUpperCase()}]`;
        });
      };
      sub(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, "email");
      sub(/\b(?:\d[ -]*?){13,16}\b/g, "card");
      sub(/\b\d{3}-\d{2}-\d{4}\b/g, "ssn");
      sub(/\b(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "phone");
      sub(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "ip");
      return { result: t, counts };
    },
  },
  {
    route: "POST /api/extract-entities", name: "Extract entities", slug: "extract-entities", category: "text", price: "$0.002",
    description: "Pull emails, URLs, IPv4s, @mentions, and #hashtags out of free text. Returns deduped lists.",
    tags: ["extract", "emails", "urls", "entities", "nlp"],
    discovery: { bodyType: "json", input: { text: "ping @ada at ada@x.com see https://x.com #news" }, inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, output: { example: { emails: ["ada@x.com"], urls: ["https://x.com"], mentions: ["@ada"], hashtags: ["#news"] } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 500_000);
      const uniq = (re) => [...new Set(t.match(re) || [])];
      return {
        emails: uniq(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g),
        urls: uniq(/https?:\/\/[^\s<>"')]+/g),
        ipv4: uniq(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g),
        mentions: uniq(/(?:^|\s)(@[A-Za-z0-9_]{1,30})/g).map((s) => s.trim()),
        hashtags: uniq(/(?:^|\s)(#[A-Za-z0-9_]{1,50})/g).map((s) => s.trim()),
      };
    },
  },
  {
    route: "POST /api/readability", name: "Readability", slug: "readability", category: "text", price: "$0.002",
    description: "Flesch Reading Ease score and Flesch–Kincaid grade level for English text, plus word/sentence/syllable counts.",
    tags: ["readability", "flesch", "nlp", "text"],
    discovery: { bodyType: "json", input: { text: "The cat sat on the mat. It was warm." }, inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, output: { example: { readingEase: 100, gradeLevel: 0.5, words: 9, sentences: 2 } } },
    handler: (i) => {
      const t = cap(need(i, "text"), 200_000);
      const words = t.match(/\b[a-zA-Z]+\b/g) || [];
      const sentences = Math.max((t.match(/[.!?]+(\s|$)/g) || []).length, 1);
      const syl = words.reduce((s, w) => s + syllables(w), 0);
      const W = Math.max(words.length, 1);
      const ease = 206.835 - 1.015 * (W / sentences) - 84.6 * (syl / W);
      const grade = 0.39 * (W / sentences) + 11.8 * (syl / W) - 15.59;
      return { readingEase: +ease.toFixed(1), gradeLevel: +grade.toFixed(1), words: words.length, sentences, syllables: syl };
    },
  },
];

// ===========================================================================
// Data conversion
// ===========================================================================

function parseCsvSimple(textIn, delimiter = ",") {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < textIn.length; i++) {
    const c = textIn[i];
    if (q) {
      if (c === '"') {
        if (textIn[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && textIn[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function flattenObj(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenObj(v, key, out);
    else out[key] = v;
  }
  return out;
}
function unflattenObj(flat) {
  const out = Object.create(null);
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split(".");
    // Block prototype-pollution via dot-paths like "__proto__.x" / "constructor.prototype.x".
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype"))
      throw bad(`unsafe key in path "${path}"`);
    let cur = out;
    parts.forEach((p, idx) => {
      if (idx === parts.length - 1) cur[p] = v;
      else cur = cur[p] ??= Object.create(null);
    });
  }
  return out;
}
function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue; // hygiene: never merge proto keys
      out[k] = k in a ? deepMerge(a[k], v) : v;
    }
    return out;
  }
  return b;
}

const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];

const conversion = [
  {
    route: "POST /api/csv-to-md", name: "CSV to Markdown table", slug: "csv-to-md", category: "conversion", price: "$0.002",
    description: "Convert CSV into a GitHub-flavored Markdown table (first row is the header).",
    tags: ["csv", "markdown", "table", "convert"],
    discovery: { bodyType: "json", input: { csv: "name,age\nAda,36\nBob,40" }, inputSchema: { properties: { csv: { type: "string" }, delimiter: { type: "string" } }, required: ["csv"] }, output: { example: { markdown: "| name | age |\n| --- | --- |\n| Ada | 36 |\n| Bob | 40 |" } } },
    handler: (i) => {
      const csv = cap(need(i, "csv"));
      const delim = typeof i.delimiter === "string" && i.delimiter.length === 1 ? i.delimiter : ",";
      const grid = parseCsvSimple(csv, delim);
      if (!grid.length) throw bad("Empty CSV");
      const cols = grid[0].length;
      const esc = (s) => String(s).replace(/\|/g, "\\|");
      const line = (r) => `| ${r.concat(Array(Math.max(0, cols - r.length)).fill("")).slice(0, cols).map(esc).join(" | ")} |`;
      const md = [line(grid[0]), `| ${Array(cols).fill("---").join(" | ")} |`, ...grid.slice(1).map(line)].join("\n");
      return { markdown: md, rows: grid.length - 1, columns: cols };
    },
  },
  {
    route: "POST /api/json-flatten", name: "JSON flatten/unflatten", slug: "json-flatten", category: "conversion", price: "$0.001",
    description: "Flatten nested JSON to dot-path keys, or unflatten dot-path keys back to nested JSON. mode: flatten (default) | unflatten.",
    tags: ["json", "flatten", "unflatten", "convert"],
    discovery: { bodyType: "json", input: { json: { a: { b: 1 } }, mode: "flatten" }, inputSchema: { properties: { json: { description: "JSON value" }, mode: { type: "string", description: "flatten | unflatten" } }, required: ["json"] }, output: { example: { result: { "a.b": 1 } } } },
    handler: (i) => {
      const data = parseMaybeJson(need(i, "json", "any"), "json");
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw bad('"json" must be an object');
      return { result: i.mode === "unflatten" ? unflattenObj(data) : flattenObj(data) };
    },
  },
  {
    route: "POST /api/json-merge", name: "JSON deep merge", slug: "json-merge", category: "conversion", price: "$0.001",
    description: "Deep-merge two JSON objects (b wins on conflicts; arrays are concatenated).",
    tags: ["json", "merge", "deep", "convert"],
    discovery: { bodyType: "json", input: { a: { x: 1, n: { p: 1 } }, b: { y: 2, n: { q: 2 } } }, inputSchema: { properties: { a: { description: "Base object" }, b: { description: "Override object" } }, required: ["a", "b"] }, output: { example: { result: { x: 1, n: { p: 1, q: 2 }, y: 2 } } } },
    handler: (i) => {
      if (!("a" in i) || !("b" in i)) throw bad('Provide "a" and "b"');
      return { result: deepMerge(parseMaybeJson(i.a, "a"), parseMaybeJson(i.b, "b")) };
    },
  },
  {
    route: "POST /api/querystring", name: "Query string", slug: "querystring", category: "conversion", price: "$0.001",
    description: "Parse a URL query string into an object, or build one from an object. mode: parse (default) | build.",
    tags: ["querystring", "url", "parse", "convert"],
    discovery: { bodyType: "json", input: { value: "a=1&b=hello%20world&a=2", mode: "parse" }, inputSchema: { properties: { value: { description: "String to parse or object to build" }, mode: { type: "string", description: "parse | build" } }, required: ["value"] }, output: { example: { result: { a: ["1", "2"], b: "hello world" } } } },
    handler: (i) => {
      if (i.mode === "build") {
        const obj = parseMaybeJson(i.value, "value");
        if (!obj || typeof obj !== "object") throw bad('"value" must be an object to build');
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(obj)) (Array.isArray(v) ? v : [v]).forEach((x) => sp.append(k, String(x)));
        return { result: sp.toString() };
      }
      const sp = new URLSearchParams(String(need(i, "value", "any")).replace(/^\?/, ""));
      const out = {};
      for (const k of new Set(sp.keys())) {
        const all = sp.getAll(k);
        out[k] = all.length > 1 ? all : all[0];
      }
      return { result: out };
    },
  },
  {
    route: "POST /api/base-convert", name: "Base / radix convert", slug: "base-convert", category: "conversion", price: "$0.001",
    description: "Convert an integer between number bases (radix 2-36), e.g. binary↔hex↔decimal. Arbitrary size via BigInt.",
    tags: ["base", "radix", "binary", "hex", "convert"],
    discovery: { bodyType: "json", input: { value: "ff", from: 16, to: 2 }, inputSchema: { properties: { value: { type: "string" }, from: { type: "number", description: "2-36" }, to: { type: "number", description: "2-36" } }, required: ["value", "from", "to"] }, output: { example: { result: "11111111" } } },
    handler: (i) => {
      const value = String(need(i, "value", "any")).trim().toLowerCase();
      // BigInt parse/format is quadratic in digit count — cap it so a paid call
      // (or a 16-bit proof-of-work) can't buy seconds of CPU.
      if (value.length > 4096) throw bad("value too long (max 4096 digits)");
      const from = parseInt(i.from, 10), to = parseInt(i.to, 10);
      if (!(from >= 2 && from <= 36 && to >= 2 && to <= 36)) throw bad("from/to must be 2-36");
      const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
      let x = 0n;
      const neg = value.startsWith("-");
      for (const ch of neg ? value.slice(1) : value) {
        const d = digits.indexOf(ch);
        if (d < 0 || d >= from) throw bad(`"${ch}" is not a valid digit in base ${from}`);
        x = x * BigInt(from) + BigInt(d);
      }
      if (x === 0n) return { result: "0", decimal: 0 };
      let out = "";
      let n = x;
      while (n > 0n) {
        out = digits[Number(n % BigInt(to))] + out;
        n /= BigInt(to);
      }
      return { result: (neg ? "-" : "") + out, decimal: Number(x) <= Number.MAX_SAFE_INTEGER ? Number(x) * (neg ? -1 : 1) : (neg ? "-" : "") + x.toString() };
    },
  },
  {
    route: "POST /api/roman", name: "Roman numerals", slug: "roman", category: "conversion", price: "$0.001",
    description: "Convert an integer (1-3999) to Roman numerals, or a Roman numeral back to an integer. Auto-detects direction.",
    tags: ["roman", "numerals", "convert"],
    discovery: { bodyType: "json", input: { value: 2024 }, inputSchema: { properties: { value: { description: "Integer 1-3999 or a Roman numeral string" } }, required: ["value"] }, output: { example: { result: "MMXXIV" } } },
    handler: (i) => {
      const v = need(i, "value", "any");
      if (typeof v === "number" || /^\d+$/.test(String(v))) {
        let n = parseInt(v, 10);
        if (!(n >= 1 && n <= 3999)) throw bad("Integer must be 1-3999");
        let out = "";
        for (const [val, sym] of ROMAN) while (n >= val) { out += sym; n -= val; }
        return { result: out };
      }
      const s = String(v).toUpperCase();
      if (!/^[MDCLXVI]+$/.test(s)) throw bad("Not a valid Roman numeral");
      const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
      let total = 0;
      for (let k = 0; k < s.length; k++) {
        const cur = map[s[k]], next = map[s[k + 1]] || 0;
        total += cur < next ? -cur : cur;
      }
      return { result: total };
    },
  },
];

// ===========================================================================
// Math & finance
// ===========================================================================

function evalExpr(expr) {
  const tokens = expr.match(/\d+\.?\d*|[()+\-*/%^]|\s+/g);
  if (!tokens || tokens.join("") !== expr) throw bad("Expression has invalid characters (allowed: numbers + - * / % ^ ( ))");
  const out = [], ops = [];
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const rightAssoc = { "^": true };
  let prevType = "start";
  const apply = () => {
    const op = ops.pop();
    if (op === "u-") { out.push(-out.pop()); return; }
    const b = out.pop(), a = out.pop();
    if (a === undefined || b === undefined) throw bad("Malformed expression");
    out.push(op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : op === "%" ? a % b : a ** b);
  };
  for (const raw of tokens) {
    if (/^\s+$/.test(raw)) continue;
    if (/^\d/.test(raw)) { out.push(parseFloat(raw)); prevType = "num"; }
    else if (raw === "(") { ops.push(raw); prevType = "("; }
    else if (raw === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") apply();
      if (!ops.length) throw bad("Mismatched parentheses");
      ops.pop(); prevType = "num";
    } else {
      let op = raw;
      if (raw === "-" && (prevType === "start" || prevType === "op" || prevType === "(")) op = "u-";
      if (op === "u-") ops.push(op);
      else {
        while (ops.length && ops[ops.length - 1] !== "(" && (ops[ops.length - 1] === "u-" || (rightAssoc[op] ? prec[ops[ops.length - 1]] > prec[op] : prec[ops[ops.length - 1]] >= prec[op]))) apply();
        ops.push(op);
      }
      prevType = "op";
    }
  }
  while (ops.length) {
    if (ops[ops.length - 1] === "(") throw bad("Mismatched parentheses");
    apply();
  }
  if (out.length !== 1 || !Number.isFinite(out[0])) throw bad("Could not evaluate expression");
  return out[0];
}

const UNITS = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  mass: { g: 1, kg: 1000, mg: 0.001, t: 1e6, lb: 453.592, oz: 28.3495, st: 6350.29 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, kbit: 128, mbit: 128 * 1024 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, d: 86400, wk: 604800, yr: 31557600 },
  speed: { mps: 1, kph: 1 / 3.6, mph: 0.44704, kn: 0.514444 },
};
function convertUnit(value, from, to) {
  from = from.toLowerCase();
  to = to.toLowerCase();
  if (["c", "f", "k"].includes(from) && ["c", "f", "k"].includes(to)) {
    let celsius = from === "c" ? value : from === "f" ? (value - 32) * 5 / 9 : value - 273.15;
    return to === "c" ? celsius : to === "f" ? celsius * 9 / 5 + 32 : celsius + 273.15;
  }
  for (const table of Object.values(UNITS)) {
    if (from in table && to in table) return (value * table[from]) / table[to];
  }
  throw bad(`Cannot convert ${from} → ${to} (unknown or incompatible units)`);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)).toFixed(6);
}

const math = [
  {
    route: "POST /api/calc", name: "Calculator", slug: "calc", category: "math", price: "$0.001",
    description: "Safely evaluate an arithmetic expression (+ - * / % ^ and parentheses). No code execution — a real parser, not eval.",
    tags: ["calc", "math", "expression", "arithmetic"],
    discovery: { bodyType: "json", input: { expr: "2 + 3 * (4 - 1) ^ 2" }, inputSchema: { properties: { expr: { type: "string" } }, required: ["expr"] }, output: { example: { result: 29 } } },
    handler: (i) => ({ result: evalExpr(cap(need(i, "expr"), 1000, "expr").trim()) }),
  },
  {
    route: "POST /api/stats", name: "Statistics", slug: "stats", category: "math", price: "$0.001",
    description: "Descriptive statistics for an array of numbers: count, sum, mean, median, mode, min, max, range, variance, stddev, and percentiles.",
    tags: ["stats", "mean", "median", "stddev", "percentile"],
    discovery: { bodyType: "json", input: { numbers: [2, 4, 4, 4, 5, 5, 7, 9] }, inputSchema: { properties: { numbers: { description: "Array of numbers" } }, required: ["numbers"] }, output: { example: { count: 8, mean: 5, median: 4.5, stddev: 2 } } },
    handler: (i) => {
      const nums = numArray(i.numbers);
      const sorted = [...nums].sort((a, b) => a - b);
      const n = nums.length;
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / n;
      const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      const freq = {};
      let mode = sorted[0], best = 0;
      for (const x of nums) { freq[x] = (freq[x] || 0) + 1; if (freq[x] > best) { best = freq[x]; mode = x; } }
      const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      return {
        count: n, sum, mean: +mean.toFixed(6), median, mode, min: sorted[0], max: sorted[n - 1],
        range: sorted[n - 1] - sorted[0], variance: +variance.toFixed(6), stddev: +Math.sqrt(variance).toFixed(6),
        p25: percentile(sorted, 25), p50: percentile(sorted, 50), p75: percentile(sorted, 75), p90: percentile(sorted, 90), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
      };
    },
  },
  {
    route: "POST /api/unit-convert", name: "Unit convert", slug: "unit-convert", category: "math", price: "$0.001",
    description: "Convert a value between units of length, mass, temperature (C/F/K), data, time, or speed.",
    tags: ["units", "convert", "length", "mass", "temperature"],
    discovery: { bodyType: "json", input: { value: 100, from: "f", to: "c" }, inputSchema: { properties: { value: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["value", "from", "to"] }, output: { example: { result: 37.778, from: "f", to: "c" } } },
    handler: (i) => {
      const value = Number(need(i, "value", "any"));
      if (!Number.isFinite(value)) throw bad('"value" must be a number');
      return { result: +convertUnit(value, need(i, "from"), need(i, "to")).toFixed(6), from: i.from, to: i.to };
    },
  },
  {
    route: "POST /api/percentage", name: "Percentage", slug: "percentage", category: "math", price: "$0.001",
    description: 'Percentage helper. op: "of" (a% of b), "change" (% change a→b), "ratio" (a is what % of b).',
    tags: ["percentage", "percent", "math"],
    discovery: { bodyType: "json", input: { op: "change", a: 80, b: 100 }, inputSchema: { properties: { op: { type: "string", description: "of | change | ratio" }, a: { type: "number" }, b: { type: "number" } }, required: ["op", "a", "b"] }, output: { example: { result: 25 } } },
    handler: (i) => {
      const a = Number(need(i, "a", "any")), b = Number(need(i, "b", "any"));
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw bad('"a" and "b" must be numbers');
      const op = need(i, "op");
      if (op === "of") return { result: +((a / 100) * b).toFixed(6) };
      if (op === "change") { if (a === 0) throw bad("base (a) cannot be 0 for change"); return { result: +(((b - a) / a) * 100).toFixed(6) }; }
      if (op === "ratio") { if (b === 0) throw bad("b cannot be 0 for ratio"); return { result: +((a / b) * 100).toFixed(6) }; }
      throw bad('op must be "of", "change", or "ratio"');
    },
  },
  {
    route: "POST /api/number-format", name: "Number format", slug: "number-format", category: "math", price: "$0.001",
    description: "Format a number: thousands separators, fixed decimals, optional currency, or compact (1.2K / 3.4M).",
    tags: ["number", "format", "currency", "commas"],
    discovery: { bodyType: "json", input: { value: 1234567.891, decimals: 2 }, inputSchema: { properties: { value: { type: "number" }, decimals: { type: "number" }, currency: { type: "string", description: "ISO code e.g. USD" }, compact: { type: "boolean" } }, required: ["value"] }, output: { example: { result: "1,234,567.89" } } },
    handler: (i) => {
      const value = Number(need(i, "value", "any"));
      if (!Number.isFinite(value)) throw bad('"value" must be a number');
      const opts = {};
      if (i.compact === true || i.compact === "true") opts.notation = "compact";
      if (i.decimals !== undefined) { opts.minimumFractionDigits = +i.decimals; opts.maximumFractionDigits = +i.decimals; }
      if (i.currency) { opts.style = "currency"; opts.currency = String(i.currency).toUpperCase(); }
      try {
        return { result: new Intl.NumberFormat("en-US", opts).format(value) };
      } catch (e) {
        throw bad(`Format error: ${e.message}`);
      }
    },
  },
  {
    route: "POST /api/cidr", name: "CIDR calculator", slug: "cidr", category: "math", price: "$0.002",
    description: "Parse an IPv4 CIDR block: network address, broadcast, first/last host, netmask, and host count. Optionally test if an IP is inside it.",
    tags: ["cidr", "subnet", "ip", "network"],
    discovery: { bodyType: "json", input: { cidr: "192.168.1.0/24", contains: "192.168.1.42" }, inputSchema: { properties: { cidr: { type: "string" }, contains: { type: "string", description: "Optional IP to test for membership" } }, required: ["cidr"] }, output: { example: { cidr: "192.168.1.0/24", network: "192.168.1.0", broadcast: "192.168.1.255", netmask: "255.255.255.0", prefix: 24, firstHost: "192.168.1.1", lastHost: "192.168.1.254", totalAddresses: 256, usableHosts: 254, contains: true } } },
    handler: (i) => {
      const cidr = need(i, "cidr").trim();
      const m = cidr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
      if (!m) throw bad("Invalid IPv4 CIDR (e.g. 10.0.0.0/24)");
      const bits = parseInt(m[2], 10);
      if (bits > 32) throw bad("Prefix must be 0-32");
      const toInt = (ip) => ip.split(".").reduce((a, o) => { const n = +o; if (n > 255) throw bad(`Invalid octet ${o}`); return a * 256 + n; }, 0) >>> 0;
      const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const net = (toInt(m[1]) & mask) >>> 0;
      const broadcast = (net | (~mask >>> 0)) >>> 0;
      const total = 2 ** (32 - bits);
      const out = {
        cidr, network: toIp(net), broadcast: toIp(broadcast), netmask: toIp(mask), prefix: bits,
        firstHost: toIp(bits >= 31 ? net : net + 1), lastHost: toIp(bits >= 31 ? broadcast : broadcast - 1),
        totalAddresses: total, usableHosts: bits >= 31 ? total : Math.max(total - 2, 0),
      };
      if (i.contains) {
        const ipN = toInt(String(i.contains).trim());
        out.contains = ipN >= net && ipN <= broadcast;
      }
      return out;
    },
  },
  {
    route: "POST /api/finance", name: "Finance", slug: "finance", category: "math", price: "$0.002",
    description: 'Financial math. op: "compound" (future value of principal at a rate) or "loan" (monthly payment + total for a loan).',
    tags: ["finance", "interest", "loan", "compound", "money"],
    discovery: { bodyType: "json", input: { op: "loan", principal: 20000, annualRatePct: 6, months: 60 }, inputSchema: { properties: { op: { type: "string", description: "compound | loan" }, principal: { type: "number" }, annualRatePct: { type: "number" }, months: { type: "number" }, years: { type: "number" }, compoundsPerYear: { type: "number" } }, required: ["op", "principal", "annualRatePct"] }, output: { example: { monthlyPayment: 386.66, totalPaid: 23199.36, totalInterest: 3199.36 } } },
    handler: (i) => {
      const P = Number(need(i, "principal", "any"));
      const r = Number(need(i, "annualRatePct", "any")) / 100;
      if (!Number.isFinite(P) || !Number.isFinite(r)) throw bad("principal and annualRatePct must be numbers");
      if (i.op === "compound") {
        const n = i.compoundsPerYear ? +i.compoundsPerYear : 12;
        const years = Number(i.years ?? 1);
        const fv = P * (1 + r / n) ** (n * years);
        return { futureValue: +fv.toFixed(2), interest: +(fv - P).toFixed(2), principal: P };
      }
      if (i.op === "loan") {
        const months = parseInt(i.months, 10);
        if (!months) throw bad('"months" is required for a loan');
        const mr = r / 12;
        const pay = mr === 0 ? P / months : (P * mr) / (1 - (1 + mr) ** -months);
        return { monthlyPayment: +pay.toFixed(2), totalPaid: +(pay * months).toFixed(2), totalInterest: +(pay * months - P).toFixed(2) };
      }
      throw bad('op must be "compound" or "loan"');
    },
  },
];

// ===========================================================================
// Time
// ===========================================================================

function parseDate(v, label = "date") {
  if (v === undefined || v === null || v === "now") return new Date();
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad(`Cannot parse ${label}: ${v}`);
  return d;
}

const time = [
  {
    route: "POST /api/business-days", name: "Business days", slug: "business-days", category: "time", price: "$0.001",
    description: "Count business days (Mon–Fri) between two dates, inclusive of the start, exclusive of the end. Optional list of holiday dates to skip.",
    tags: ["business-days", "weekdays", "date", "time"],
    discovery: { bodyType: "json", input: { from: "2026-06-01", to: "2026-06-08", holidays: [] }, inputSchema: { properties: { from: { description: "Start date" }, to: { description: "End date" }, holidays: { description: "Optional array of YYYY-MM-DD to exclude" } }, required: ["from", "to"] }, output: { example: { businessDays: 5, calendarDays: 7 } } },
    handler: (i) => {
      const from = parseDate(need(i, "from", "any"), "from");
      const to = parseDate(need(i, "to", "any"), "to");
      const holidays = new Set((Array.isArray(i.holidays) ? i.holidays : []).map((h) => new Date(h).toISOString().slice(0, 10)));
      const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      let days = 0, cur = new Date(start);
      const dir = end >= start ? 1 : -1;
      while (dir > 0 ? cur < end : cur > end) {
        const dow = cur.getUTCDay();
        if (dow !== 0 && dow !== 6 && !holidays.has(cur.toISOString().slice(0, 10))) days++;
        cur.setUTCDate(cur.getUTCDate() + dir);
      }
      return { businessDays: days * dir < 0 ? -days : days, calendarDays: Math.round((end - start) / 86400000) };
    },
  },
  {
    route: "POST /api/age", name: "Age calculator", slug: "age", category: "time", price: "$0.001",
    description: "Compute a precise age (years, months, days) from a birth date to today (or a given date), plus total days.",
    tags: ["age", "birthday", "date", "time"],
    discovery: { bodyType: "json", input: { birthdate: "1990-05-20" }, inputSchema: { properties: { birthdate: { description: "Birth date" }, asOf: { description: "Reference date (default now)" } }, required: ["birthdate"] }, output: { example: { years: 36, months: 0, days: 22, totalDays: 13166 } } },
    handler: (i) => {
      const b = parseDate(need(i, "birthdate", "any"), "birthdate");
      const now = parseDate(i.asOf, "asOf");
      if (b > now) throw bad("birthdate is in the future");
      let years = now.getUTCFullYear() - b.getUTCFullYear();
      let months = now.getUTCMonth() - b.getUTCMonth();
      let days = now.getUTCDate() - b.getUTCDate();
      if (days < 0) { months--; days += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate(); }
      if (months < 0) { years--; months += 12; }
      return { years, months, days, totalDays: Math.floor((now - b) / 86400000) };
    },
  },
  {
    route: "POST /api/relative-time", name: "Relative time", slug: "relative-time", category: "time", price: "$0.001",
    description: 'Format a timestamp as a human relative phrase ("3 hours ago", "in 2 days") versus now or a reference time.',
    tags: ["relative-time", "humanize", "date", "time"],
    discovery: { bodyType: "json", input: { time: "2026-06-11T09:00:00Z", from: "2026-06-11T12:00:00Z" }, inputSchema: { properties: { time: { description: "Target timestamp" }, from: { description: "Reference (default now)" } }, required: ["time"] }, output: { example: { result: "3 hours ago", seconds: -10800 } } },
    handler: (i) => {
      const t = parseDate(need(i, "time", "any"), "time");
      const from = parseDate(i.from, "from");
      const diff = Math.round((t - from) / 1000);
      const abs = Math.abs(diff);
      const units = [["year", 31557600], ["month", 2629800], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
      let result = "just now";
      for (const [name, s] of units) {
        if (abs >= s) {
          const n = Math.floor(abs / s);
          result = diff < 0 ? `${n} ${name}${n > 1 ? "s" : ""} ago` : `in ${n} ${name}${n > 1 ? "s" : ""}`;
          break;
        }
      }
      return { result, seconds: diff };
    },
  },
  {
    route: "POST /api/add-time", name: "Date arithmetic", slug: "add-time", category: "time", price: "$0.001",
    description: 'Add (or subtract) a duration to a date. duration like "2d", "-3h", "1w 2d", "90m". Returns the resulting UTC ISO timestamp.',
    tags: ["date", "add", "duration", "time", "arithmetic"],
    discovery: { bodyType: "json", input: { date: "2026-06-11T12:00:00Z", duration: "2d 3h" }, inputSchema: { properties: { date: { description: "Base date (default now)" }, duration: { type: "string", description: 'e.g. "2d", "-3h", "1w"' } }, required: ["duration"] }, output: { example: { result: "2026-06-13T15:00:00.000Z" } } },
    handler: (i) => {
      const base = parseDate(i.date, "date");
      const dur = cap(need(i, "duration"), 100, "duration").toLowerCase();
      const sign = dur.trim().startsWith("-") ? -1 : 1;
      const matches = [...dur.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g)];
      if (!matches.length) throw bad('Cannot parse "duration" (e.g. "2d 3h")');
      const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
      const secs = matches.reduce((a, mt) => a + Number(mt[1]) * mult[mt[2]], 0) * sign;
      return { result: new Date(base.getTime() + secs * 1000).toISOString(), addedSeconds: secs };
    },
  },
];

// ===========================================================================
// Validation
// ===========================================================================

const validation = [
  {
    route: "POST /api/isbn-validate", name: "ISBN validate", slug: "isbn-validate", category: "validation", price: "$0.001",
    description: "Validate an ISBN-10 or ISBN-13 checksum (hyphens/spaces ignored) and report which format it is.",
    tags: ["isbn", "books", "validate", "checksum"],
    discovery: { bodyType: "json", input: { isbn: "978-0-306-40615-7" }, inputSchema: { properties: { isbn: { type: "string" } }, required: ["isbn"] }, output: { example: { valid: true, format: "ISBN-13" } } },
    handler: (i) => {
      const raw = need(i, "isbn").replace(/[\s-]/g, "").toUpperCase();
      if (/^\d{9}[\dX]$/.test(raw)) {
        let sum = 0;
        for (let k = 0; k < 10; k++) sum += (k === 9 && raw[k] === "X" ? 10 : +raw[k]) * (10 - k);
        return { valid: sum % 11 === 0, format: "ISBN-10" };
      }
      if (/^\d{13}$/.test(raw)) {
        let sum = 0;
        for (let k = 0; k < 13; k++) sum += +raw[k] * (k % 2 ? 3 : 1);
        return { valid: sum % 10 === 0, format: "ISBN-13" };
      }
      return { valid: false, reason: "Not 10 or 13 digits" };
    },
  },
  {
    route: "POST /api/password-strength", name: "Password strength", slug: "password-strength", category: "validation", price: "$0.001",
    description: "Score a password's strength: character-set size, entropy bits, a 0–4 rating, and an estimated offline crack time. The password is never stored or logged.",
    tags: ["password", "strength", "entropy", "security"],
    discovery: { bodyType: "json", input: { password: "Tr0ub4dour&3" }, inputSchema: { properties: { password: { type: "string" } }, required: ["password"] }, output: { example: { entropyBits: 72, score: 3, rating: "strong", crackTime: "centuries" } } },
    handler: (i) => {
      const pw = cap(need(i, "password"), 1024, "password");
      let pool = 0;
      if (/[a-z]/.test(pw)) pool += 26;
      if (/[A-Z]/.test(pw)) pool += 26;
      if (/[0-9]/.test(pw)) pool += 10;
      if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
      const entropy = pw.length * Math.log2(pool || 1);
      const seconds = pool ? 2 ** entropy / 2 / 1e10 : 0; // ~10B guesses/sec, avg half the space
      const human = (s) => {
        const u = [["seconds", 60], ["minutes", 60], ["hours", 24], ["days", 365], ["years", 100], ["centuries", Infinity]];
        let v = s;
        for (const [name, step] of u) { if (v < step || step === Infinity) return v < 1 && name === "seconds" ? "instant" : `${name === "centuries" ? "" : Math.round(v) + " "}${name}`; v /= step; }
        return "centuries";
      };
      const score = entropy < 28 ? 0 : entropy < 40 ? 1 : entropy < 60 ? 2 : entropy < 80 ? 3 : 4;
      return { length: pw.length, charsetSize: pool, entropyBits: +entropy.toFixed(1), score, rating: ["very weak", "weak", "fair", "strong", "very strong"][score], crackTime: human(seconds) };
    },
  },
  {
    route: "POST /api/json-pointer", name: "JSON pointer", slug: "json-pointer", category: "validation", price: "$0.001",
    description: "Resolve an RFC 6901 JSON Pointer (e.g. /items/0/name) against a JSON value. Returns the value or found:false.",
    tags: ["json", "pointer", "rfc6901", "query"],
    discovery: { bodyType: "json", input: { json: { items: [{ name: "a" }, { name: "b" }] }, pointer: "/items/1/name" }, inputSchema: { properties: { json: { description: "JSON value" }, pointer: { type: "string", description: "RFC 6901 pointer" } }, required: ["json", "pointer"] }, output: { example: { found: true, value: "b" } } },
    handler: (i) => {
      const data = parseMaybeJson(need(i, "json", "any"), "json");
      const ptr = need(i, "pointer");
      if (ptr === "") return { found: true, value: data };
      if (ptr[0] !== "/") throw bad('Pointer must start with "/" (or be empty for the whole document)');
      let cur = data;
      for (const rawTok of ptr.slice(1).split("/")) {
        const tok = rawTok.replace(/~1/g, "/").replace(/~0/g, "~");
        if (cur === null || typeof cur !== "object") return { found: false, value: null };
        cur = Array.isArray(cur) ? cur[/^\d+$/.test(tok) ? Number(tok) : NaN] : cur[tok];
        if (cur === undefined) return { found: false, value: null };
      }
      return { found: true, value: cur };
    },
  },
  {
    route: "POST /api/uuid-validate", name: "UUID validate", slug: "uuid-validate", category: "validation", price: "$0.001",
    description: "Validate a UUID and report its version (1-8) and variant. Accepts hyphenated or braced forms.",
    tags: ["uuid", "validate", "version"],
    discovery: { bodyType: "json", input: { uuid: "0190a1b2-3c4d-7e6f-8a9b-0c1d2e3f4a5b" }, inputSchema: { properties: { uuid: { type: "string" } }, required: ["uuid"] }, output: { example: { valid: true, version: 7, variant: "RFC 9562" } } },
    handler: (i) => {
      const u = need(i, "uuid").trim().replace(/^\{|\}$/g, "").toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)) return { valid: false, reason: "Not a well-formed UUID" };
      if (u === "00000000-0000-0000-0000-000000000000") return { valid: true, version: 0, variant: "nil" };
      const version = parseInt(u[14], 16);
      const vbits = parseInt(u[19], 16);
      const variant = vbits >= 8 && vbits <= 0xb ? "RFC 9562" : vbits >= 0xc ? "Microsoft" : "reserved/NCS";
      return { valid: true, version, variant };
    },
  },
];

export const KIT2 = [...encoding, ...text, ...conversion, ...math, ...time, ...validation];
