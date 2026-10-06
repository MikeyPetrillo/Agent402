// Kit 2 — 39 more pure-CPU tools (free via proof-of-work). All deterministic,
// no network, ~zero cost to serve, and each covered by an exact-output test in
// scripts/test-kit2.js.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { convertAnyUnit, UNIT_CATEGORIES } from "./convert-gen.js";

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
// The HTML 4 named entities (252) plus &#39;. The first cut decoded seven names
// and returned every other one VERBATIM as a 200 - a partially decoded string
// is a wrong answer that looks right (corpus, 2026-09-06). Generated from the
// `entities` package's own decoder; never hand-edit a code point here.
const HTML_ENT_REV = {"#39":"'","nbsp":" ","iexcl":"¡","cent":"¢","pound":"£","curren":"¤","yen":"¥","brvbar":"¦","sect":"§","uml":"¨","copy":"©","ordf":"ª","laquo":"«","not":"¬","shy":"­","reg":"®","macr":"¯","deg":"°","plusmn":"±","sup2":"²","sup3":"³","acute":"´","micro":"µ","para":"¶","middot":"·","cedil":"¸","sup1":"¹","ordm":"º","raquo":"»","frac14":"¼","frac12":"½","frac34":"¾","iquest":"¿","Agrave":"À","Aacute":"Á","Acirc":"Â","Atilde":"Ã","Auml":"Ä","Aring":"Å","AElig":"Æ","Ccedil":"Ç","Egrave":"È","Eacute":"É","Ecirc":"Ê","Euml":"Ë","Igrave":"Ì","Iacute":"Í","Icirc":"Î","Iuml":"Ï","ETH":"Ð","Ntilde":"Ñ","Ograve":"Ò","Oacute":"Ó","Ocirc":"Ô","Otilde":"Õ","Ouml":"Ö","times":"×","Oslash":"Ø","Ugrave":"Ù","Uacute":"Ú","Ucirc":"Û","Uuml":"Ü","Yacute":"Ý","THORN":"Þ","szlig":"ß","agrave":"à","aacute":"á","acirc":"â","atilde":"ã","auml":"ä","aring":"å","aelig":"æ","ccedil":"ç","egrave":"è","eacute":"é","ecirc":"ê","euml":"ë","igrave":"ì","iacute":"í","icirc":"î","iuml":"ï","eth":"ð","ntilde":"ñ","ograve":"ò","oacute":"ó","ocirc":"ô","otilde":"õ","ouml":"ö","divide":"÷","oslash":"ø","ugrave":"ù","uacute":"ú","ucirc":"û","uuml":"ü","yacute":"ý","thorn":"þ","yuml":"ÿ","fnof":"ƒ","Alpha":"Α","Beta":"Β","Gamma":"Γ","Delta":"Δ","Epsilon":"Ε","Zeta":"Ζ","Eta":"Η","Theta":"Θ","Iota":"Ι","Kappa":"Κ","Lambda":"Λ","Mu":"Μ","Nu":"Ν","Xi":"Ξ","Omicron":"Ο","Pi":"Π","Rho":"Ρ","Sigma":"Σ","Tau":"Τ","Upsilon":"Υ","Phi":"Φ","Chi":"Χ","Psi":"Ψ","Omega":"Ω","alpha":"α","beta":"β","gamma":"γ","delta":"δ","epsilon":"ε","zeta":"ζ","eta":"η","theta":"θ","iota":"ι","kappa":"κ","lambda":"λ","mu":"μ","nu":"ν","xi":"ξ","omicron":"ο","pi":"π","rho":"ρ","sigmaf":"ς","sigma":"σ","tau":"τ","upsilon":"υ","phi":"φ","chi":"χ","psi":"ψ","omega":"ω","thetasym":"ϑ","upsih":"ϒ","piv":"ϖ","bull":"•","hellip":"…","prime":"′","Prime":"″","oline":"‾","frasl":"⁄","weierp":"℘","image":"ℑ","real":"ℜ","trade":"™","alefsym":"ℵ","larr":"←","uarr":"↑","rarr":"→","darr":"↓","harr":"↔","crarr":"↵","lArr":"⇐","uArr":"⇑","rArr":"⇒","dArr":"⇓","hArr":"⇔","forall":"∀","part":"∂","exist":"∃","empty":"∅","nabla":"∇","isin":"∈","notin":"∉","ni":"∋","prod":"∏","sum":"∑","minus":"−","lowast":"∗","radic":"√","prop":"∝","infin":"∞","ang":"∠","and":"∧","or":"∨","cap":"∩","cup":"∪","int":"∫","there4":"∴","sim":"∼","cong":"≅","asymp":"≈","ne":"≠","equiv":"≡","le":"≤","ge":"≥","sub":"⊂","sup":"⊃","nsub":"⊄","sube":"⊆","supe":"⊇","oplus":"⊕","otimes":"⊗","perp":"⊥","sdot":"⋅","lceil":"⌈","rceil":"⌉","lfloor":"⌊","rfloor":"⌋","lang":"⟨","rang":"⟩","loz":"◊","spades":"♠","clubs":"♣","hearts":"♥","diams":"♦","quot":"\"","amp":"&","lt":"<","gt":">","apos":"'","OElig":"Œ","oelig":"œ","Scaron":"Š","scaron":"š","Yuml":"Ÿ","circ":"ˆ","tilde":"˜","ensp":" ","emsp":" ","thinsp":" ","zwnj":"‌","zwj":"‍","lrm":"‎","rlm":"‏","ndash":"–","mdash":"—","lsquo":"‘","rsquo":"’","sbquo":"‚","ldquo":"“","rdquo":"”","bdquo":"„","dagger":"†","Dagger":"‡","permil":"‰","lsaquo":"‹","rsaquo":"›","euro":"€"};

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
    route: "POST /api/jwt-verify", name: "JWT verify (HMAC)", slug: "jwt-verify", category: "encoding", price: "$0.001",
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
      // a word - both sides of the boundary are non-whitespace).
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
      const ci = i.ci === true || i.ci === "true";
      if (i.unique === true || i.unique === "true") {
        // unique under ci folds case too: "a" and "A" are one line (first
        // spelling kept), otherwise ci:true + unique:true still returned both.
        const seen = new Set(); lines = lines.filter((l) => { const k = ci ? l.toLowerCase() : l; if (seen.has(k)) return false; seen.add(k); return true; });
      }
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
    route: "POST /api/readability", name: "Readability", slug: "readability", category: "text", price: "$0.001",
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
    route: "POST /api/csv-to-md", name: "CSV to Markdown table", slug: "csv-to-md", aliases: ["csv-to-markdown", "csv-to-markdown-table"], category: "conversion", price: "$0.002",
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
      const mode = i.mode === undefined || i.mode === null || i.mode === "" ? "parse" : String(i.mode).trim().toLowerCase();
      if (mode !== "parse" && mode !== "build") throw bad('"mode" must be parse or build');
      if (mode === "build") {
        const obj = parseMaybeJson(i.value, "value");
        if (!obj || typeof obj !== "object") throw bad('"value" must be an object to build');
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(obj)) (Array.isArray(v) ? v : [v]).forEach((x) => sp.append(k, String(x)));
        return { result: sp.toString() };
      }
      if (typeof need(i, "value", "any") !== "string") throw bad('"value" must be a query string to parse (use mode "build" for an object)');
      const sp = new URLSearchParams(String(i.value).replace(/^\?/, ""));
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
      // BigInt parse/format is quadratic in digit count - cap it so a paid call
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
      // Charset-only wasn't enough - "IIII", "VV", "IC" all passed. Require the
      // canonical form to round-trip: re-encode the parsed value and demand it
      // equals the input, which rejects any non-standard numeral.
      let canon = "", n = total;
      for (const [val, sym] of ROMAN) while (n >= val) { canon += sym; n -= val; }
      if (canon !== s) throw bad("Not a valid Roman numeral");
      return { result: total };
    },
  },
  {
    route: "POST /api/srt-convert", name: "Subtitle convert (SRT/VTT)", slug: "srt-convert", category: "conversion", price: "$0.002",
    description:
      "Convert subtitles between SRT, WebVTT, plain text, and JSON cues. Send SRT or VTT text (auto-detected) - or a JSON cues array [{start,end,text}] with times in ms - and the target format. Deterministic, pure CPU.",
    tags: ["srt", "vtt", "subtitles", "captions", "convert", "webvtt"],
    discovery: {
      bodyType: "json",
      input: { input: "1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:03,500 --> 00:00:05,000\nSecond line\n", to: "vtt" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "SRT or WebVTT text (format auto-detected)" },
          cues: { type: "array", description: "alternative: cue objects [{start,end,text}] with start/end in milliseconds" },
          to: { type: "string", description: "target format: srt | vtt | text | json" },
        },
        required: ["to"],
      },
      output: { example: { detected: "srt", to: "vtt", count: 2, result: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n00:00:03.500 --> 00:00:05.000\nSecond line\n" } },
    },
    handler: (i) => {
      const to = String(need(i, "to")).toLowerCase();
      if (!["srt", "vtt", "text", "json"].includes(to)) throw bad('to must be "srt", "vtt", "text", or "json"');
      let cues, detected;
      if (Array.isArray(i.cues)) {
        if (i.cues.length > 5000) throw bad("too many cues (max 5000)");
        detected = "json";
        cues = i.cues.map((c, k) => {
          const start = parseCueTime(c && c.start), end = parseCueTime(c && c.end);
          if (start === null || end === null) throw bad(`cues[${k}] needs numeric ms (or "HH:MM:SS,mmm") start and end`);
          return { start, end, text: cap(String(c.text ?? ""), 10_000, `cues[${k}].text`) };
        });
      } else {
        const parsed = parseSubtitles(cap(need(i, "input"), 200_000, "input"));
        cues = parsed.cues;
        detected = parsed.detected;
        if (!cues.length) throw bad("no subtitle cues found in input");
      }
      const count = cues.length;
      if (to === "json") return { detected, to, count, cues: cues.map((c, k) => ({ index: k + 1, ...c, startTime: fmtCueTime(c.start, ","), endTime: fmtCueTime(c.end, ",") })) };
      let result;
      if (to === "text") result = cues.map((c) => c.text).join("\n");
      else if (to === "srt") result = cues.map((c, k) => `${k + 1}\n${fmtCueTime(c.start, ",")} --> ${fmtCueTime(c.end, ",")}\n${c.text}`).join("\n\n") + "\n";
      else result = "WEBVTT\n\n" + cues.map((c) => `${fmtCueTime(c.start, ".")} --> ${fmtCueTime(c.end, ".")}\n${c.text}`).join("\n\n") + "\n";
      return { detected, to, count, result };
    },
  },
  {
    route: "POST /api/ics-parse", name: "iCalendar parse (.ics)", slug: "ics-parse", category: "conversion", price: "$0.001",
    description:
      "Parse iCalendar (.ics) text into structured JSON events: summary, start/end, location, organizer, attendees, status, and RRULE. Optional bounded recurrence expansion (expand:true, capped occurrences). Deterministic, pure CPU - send the ICS text, not a URL.",
    tags: ["ics", "icalendar", "calendar", "vevent", "rrule", "parse", "convert"],
    discovery: {
      bodyType: "json",
      input: {
        ics: "BEGIN:VCALENDAR\nPRODID:-//Agent402//EN\nVERSION:2.0\nBEGIN:VEVENT\nUID:demo-1\nSUMMARY:Team sync\nDTSTART:20260720T150000Z\nDTEND:20260720T153000Z\nLOCATION:Zoom\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\nEND:VCALENDAR",
        expand: true,
      },
      inputSchema: {
        properties: {
          ics: { type: "string", description: "iCalendar (.ics) text (VCALENDAR with VEVENTs)" },
          expand: { type: "boolean", description: "expand simple RRULEs into occurrence dates (default false)" },
          maxOccurrences: { type: "integer", description: "per-event expansion cap, 1-100 (default 50)" },
        },
        required: ["ics"],
      },
      output: {
        example: {
          calendar: { prodId: "-//Agent402//EN", version: "2.0", name: null, timezone: null },
          count: 1,
          events: [{
            uid: "demo-1", summary: "Team sync", location: "Zoom", status: null,
            start: { iso: "2026-07-20T15:00:00Z", allDay: false, tzid: null },
            end: { iso: "2026-07-20T15:30:00Z", allDay: false, tzid: null },
            rrule: { raw: "FREQ=WEEKLY;COUNT=3", freq: "WEEKLY", interval: 1, count: 3 },
            occurrences: { count: 3, capped: false, dates: ["2026-07-20T15:00:00Z", "2026-07-27T15:00:00Z", "2026-08-03T15:00:00Z"] },
          }],
        },
      },
    },
    handler: (i) => {
      const text = cap(need(i, "ics"), 300_000, "ics");
      if (!/BEGIN:VCALENDAR/i.test(text)) throw bad("ics does not look like iCalendar text (no BEGIN:VCALENDAR)");
      const expand = i.expand === true || i.expand === "true";
      let maxOcc = Number(i.maxOccurrences ?? 50);
      if (!Number.isInteger(maxOcc) || maxOcc < 1 || maxOcc > 100) {
        if (i.maxOccurrences !== undefined) throw bad("maxOccurrences must be an integer between 1 and 100");
        maxOcc = 50;
      }
      const lines = unfoldIcs(text);
      const calendar = { prodId: null, version: null, name: null, timezone: null };
      const events = [];
      let ev = null, truncated = false, depth = 0;
      for (const line of lines) {
        const p = parseIcsLine(line);
        if (!p) continue;
        if (p.name === "BEGIN") {
          const comp = p.value.trim().toUpperCase();
          if (comp === "VEVENT" && depth === 0) {
            if (events.length >= 500) { truncated = true; ev = null; }
            else ev = { uid: null, summary: null, description: null, location: null, status: null, organizer: null, attendees: [], categories: [], url: null, start: null, end: null, duration: null, rrule: null, sequence: null };
            depth = 1;
          } else if (depth >= 1) depth++;
          continue;
        }
        if (p.name === "END") {
          const comp = p.value.trim().toUpperCase();
          if (comp === "VEVENT" && depth === 1) { if (ev) events.push(ev); ev = null; depth = 0; }
          else if (depth >= 1) depth--;
          continue;
        }
        if (!ev) {
          if (depth !== 0) continue; // inside a non-VEVENT component (VTIMEZONE etc.)
          if (p.name === "PRODID") calendar.prodId = unescapeIcsText(p.value);
          else if (p.name === "VERSION") calendar.version = p.value.trim();
          else if (p.name === "X-WR-CALNAME") calendar.name = unescapeIcsText(p.value);
          else if (p.name === "X-WR-TIMEZONE") calendar.timezone = p.value.trim();
          continue;
        }
        if (depth !== 1) continue; // nested component (VALARM) properties don't belong to the event
        switch (p.name) {
          case "UID": ev.uid = p.value.trim(); break;
          case "SUMMARY": ev.summary = unescapeIcsText(p.value); break;
          case "DESCRIPTION": ev.description = unescapeIcsText(p.value).slice(0, 10_000); break;
          case "LOCATION": ev.location = unescapeIcsText(p.value); break;
          case "STATUS": ev.status = p.value.trim().toUpperCase(); break;
          case "URL": ev.url = p.value.trim(); break;
          case "DURATION": ev.duration = p.value.trim(); break;
          case "SEQUENCE": ev.sequence = Number.parseInt(p.value, 10); if (!Number.isFinite(ev.sequence)) ev.sequence = null; break;
          case "ORGANIZER": ev.organizer = { name: p.params.CN || null, uri: p.value.trim() }; break;
          case "ATTENDEE": if (ev.attendees.length < 50) ev.attendees.push({ name: p.params.CN || null, uri: p.value.trim(), role: p.params.ROLE || null, status: p.params.PARTSTAT || null }); break;
          case "CATEGORIES": ev.categories.push(...unescapeIcsText(p.value).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20)); break;
          case "DTSTART": ev.start = parseIcsDate(p.value, p.params); break;
          case "DTEND": ev.end = parseIcsDate(p.value, p.params); break;
          case "RRULE": ev.rrule = parseIcsRrule(p.value); break;
        }
      }
      if (!events.length) throw bad("no VEVENT components found in the ICS text");
      if (expand) {
        for (const e of events) {
          e.occurrences = e.rrule && e.start ? expandIcsRrule(e.start, e.rrule, maxOcc) : null;
        }
      }
      // internal ms field is for expansion only — keep the payload clean
      for (const e of events) {
        if (e.start) delete e.start.ms;
        if (e.end) delete e.end.ms;
      }
      const out = { calendar, count: events.length, events };
      if (truncated) out.truncated = true;
      return out;
    },
  },
];

// --- iCalendar helpers for /api/ics-parse -----------------------------------
// RFC 5545 line unfolding: CRLF (or LF) followed by a space/tab continues the
// previous line.
function unfoldIcs(text) {
  const raw = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.trim() !== "");
}

// Split "NAME;PARAM=V;PARAM2="q:v":value" at the first ":" outside quotes.
function parseIcsLine(line) {
  let inQ = false, ci = -1;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === '"') inQ = !inQ;
    else if (ch === ":" && !inQ) { ci = k; break; }
  }
  if (ci <= 0) return null;
  const left = line.slice(0, ci), value = line.slice(ci + 1);
  const parts = [];
  let cur = "", q = false;
  for (const ch of left) {
    if (ch === '"') { q = !q; cur += ch; }
    else if (ch === ";" && !q) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  const name = parts[0].trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function unescapeIcsText(v) {
  return v.replace(/\\(n|N|,|;|\\)/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// DTSTART/DTEND: 20260720T150000Z (UTC), 20260720T150000 (floating/TZID-local),
// or 20260720 (all-day). `ms` treats floating times as UTC for arithmetic only.
function parseIcsDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  const tzid = params.TZID || null;
  if (!m) return { raw: value, iso: null, allDay: false, tzid };
  const [, Y, Mo, D, h, mi, s, z] = m;
  const allDay = h === undefined;
  const iso = allDay ? `${Y}-${Mo}-${D}` : `${Y}-${Mo}-${D}T${h}:${mi}:${s}${z ? "Z" : ""}`;
  return { raw: value, iso, allDay, tzid, ms: Date.UTC(+Y, +Mo - 1, +D, +(h ?? 0), +(mi ?? 0), +(s ?? 0)) };
}

const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseIcsRrule(value) {
  const rule = { raw: value.trim() };
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase(), v = part.slice(eq + 1).trim();
    if (k === "FREQ") rule.freq = v.toUpperCase();
    else if (k === "INTERVAL") { const n = Number.parseInt(v, 10); if (n > 0) rule.interval = n; }
    else if (k === "COUNT") { const n = Number.parseInt(v, 10); if (n > 0) rule.count = n; }
    else if (k === "UNTIL") rule.until = parseIcsDate(v).iso ?? v;
    else if (k === "BYDAY") rule.byday = v.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    else rule[k.toLowerCase()] = v; // bymonthday, bysetpos, wkst… kept verbatim
  }
  if (rule.interval === undefined) rule.interval = 1;
  return rule;
}

// Bounded expansion of the common RRULE shapes (FREQ + INTERVAL + COUNT/UNTIL,
// plus BYDAY for WEEKLY). Anything fancier (BYMONTHDAY, BYSETPOS, positional
// BYDAY like 2MO…) returns supported:false rather than guessing. Deterministic:
// anchored on DTSTART, never on the current clock.
function expandIcsRrule(start, rule, maxOcc) {
  const DAY = 86_400_000;
  const unsupported =
    !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq) ||
    start.ms === undefined ||
    rule.bymonthday !== undefined || rule.bysetpos !== undefined || rule.bymonth !== undefined ||
    (rule.byday && (rule.freq !== "WEEKLY" || rule.byday.some((d) => !(d in ICS_DAYS))));
  if (unsupported) return { supported: false, count: 0, capped: false, dates: [] };
  // rule.until is the ISO form from parseIcsRrule — strip separators back to
  // the compact ICS form so parseIcsDate can re-read it into ms.
  const untilMs = rule.until ? parseIcsDate(String(rule.until).replace(/[-:]/g, "")).ms ?? Infinity : Infinity;
  const limit = Math.min(rule.count ?? Infinity, maxOcc);
  const fmt = (ms) => {
    const d = new Date(ms);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    if (start.allDay) return date;
    return `${date}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${/Z$/.test(start.iso) ? "Z" : ""}`;
  };
  const out = [];
  const push = (ms) => { if (ms <= untilMs && out.length < limit) { out.push(ms); return true; } return false; };
  const interval = rule.interval;
  if (rule.freq === "WEEKLY" && rule.byday && rule.byday.length) {
    // Week-indexed day walk (WKST=MO default). DTSTART is always the first
    // occurrence per RFC 5545, even if its weekday isn't in BYDAY.
    push(start.ms);
    const days = new Set(rule.byday.map((d) => ICS_DAYS[d]));
    const weekStart = (ms) => ms - (((new Date(ms).getUTCDay() + 6) % 7) * DAY);
    const anchor = weekStart(start.ms);
    for (let k = 1; k <= 3700; k++) {
      const ms = start.ms + k * DAY;
      if (out.length >= limit || ms > untilMs) break;
      const weekIdx = Math.round((weekStart(ms) - anchor) / (7 * DAY));
      if (weekIdx % interval === 0 && days.has(new Date(ms).getUTCDay())) push(ms);
    }
  } else if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    const step = interval * DAY * (rule.freq === "WEEKLY" ? 7 : 1);
    for (let k = 0; k < 100_000; k++) if (!push(start.ms + k * step)) break;
  } else {
    // MONTHLY / YEARLY: same day-of-month; months lacking it are skipped (RFC).
    const d0 = new Date(start.ms);
    const [y0, mo0, day] = [d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()];
    const timeMs = start.ms - Date.UTC(y0, mo0, day);
    for (let k = 0; k < 2400; k++) {
      const ms = rule.freq === "MONTHLY" ? Date.UTC(y0, mo0 + k * interval, day) + timeMs : Date.UTC(y0 + k * interval, mo0, day) + timeMs;
      const d = new Date(ms - timeMs);
      if (d.getUTCDate() !== day || (rule.freq === "YEARLY" && d.getUTCMonth() !== mo0)) continue; // Feb 31 → skip
      if (ms > untilMs || out.length >= limit) break;
      out.push(ms);
    }
  }
  // capped = we stopped at maxOcc while the rule itself wanted more.
  const capped = out.length >= maxOcc && (rule.count === undefined || rule.count > out.length);
  return { count: out.length, capped, dates: out.map(fmt) };
}

// Subtitle helpers for /api/srt-convert. Cue times are held as integer ms.
const CUE_TIME_RE = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
function parseCueTime(v) {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v !== "string") return null;
  const m = CUE_TIME_RE.exec(v.trim());
  if (!m) return null;
  return (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));
}
function fmtCueTime(ms, msSep) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${msSep}${p(ms % 1000, 3)}`;
}
function parseSubtitles(text) {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const detected = /^WEBVTT/.test(src.trimStart()) ? "vtt" : "srt";
  const cues = [];
  for (const blockRaw of src.split(/\n{2,}/)) {
    const block = blockRaw.trim();
    if (!block || /^WEBVTT/.test(block) || /^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti === -1) continue;
    const [startRaw, endRaw = ""] = lines[ti].split("-->");
    const start = parseCueTime(startRaw.trim());
    const end = parseCueTime(endRaw.trim().split(/\s+/)[0]); // drop VTT cue settings
    if (start === null || end === null) continue;
    if (cues.length >= 5000) throw bad("too many cues (max 5000)");
    cues.push({ start, end, text: lines.slice(ti + 1).join("\n").trim() });
  }
  return { cues, detected };
}

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

// unit-convert now delegates to the full 13-category table in convert-gen.js
// (every unit the retired pairwise convert-* endpoints handled). The short ids
// this tool historically accepted stay working as aliases; kbit/mbit/gbit have
// no full-name id in the table, so they resolve to bits with a multiplier.
export const UNIT_ALIASES = {
  m: "meters", km: "kilometers", cm: "centimeters", mm: "millimeters", mi: "miles",
  yd: "yards", ft: "feet", in: "inches", nmi: "nautical-miles",
  g: "grams", kg: "kilograms", mg: "milligrams", t: "tonnes", lb: "pounds", oz: "ounces", st: "stones",
  b: "bytes", byte: "bytes", bit: "bits", kb: "kilobytes", mb: "megabytes", gb: "gigabytes", tb: "terabytes",
  kib: "kibibytes", mib: "mebibytes", gib: "gibibytes", tib: "tebibytes",
  kbit: ["bits", 1000], mbit: ["bits", 1e6], gbit: ["bits", 1e9],
  s: "seconds", ms: "milliseconds", min: "minutes", h: "hours", d: "days", wk: "weeks", yr: "years",
  mps: "meters-per-second", kph: "kilometers-per-hour", mph: "miles-per-hour", kn: "knots",
  c: "celsius", f: "fahrenheit", k: "kelvin", r: "rankine",
  verst: "versts", sazhen: "sazhens", arshin: "arshins", vershok: "vershoks", pood: "poods", funt: "funts", zolotnik: "zolotniks",
};
// Every unit id the table knows, so a guessed spelling can only ever resolve to
// a unit that exists - never to something the buyer did not mean.
const KNOWN_UNIT_IDS = new Set(Object.values(UNIT_CATEGORIES).flatMap((c) => Object.keys(c.units)));

/** The obvious other spellings of a unit id, tried only when the exact id is
 *  unknown. Measured 2026-09-21: one real buyer made ~18 calls and got a 400
 *  on most of them for "kilopascal" (we list kilopascals), "bar" (bars),
 *  "millilitres" (milliliters), "mechanical-horsepower" (horsepower),
 *  "btu-per-hour" (btus-per-hour), "statute miles" (miles) - each a unit we
 *  convert, one spelling away, refused with a message listing the spelling we
 *  wanted. Same class as the input-aliases rule: accept the obvious other
 *  name, never a wrong one. Every candidate is checked against
 *  KNOWN_UNIT_IDS, so this can widen what we accept and cannot change what a
 *  known id means; a name that resolves nowhere still gets the 400. */
export function normalizeUnitId(raw) {
  let u = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/^statute-/, "");
  if (KNOWN_UNIT_IDS.has(u)) return u;
  // British spellings.
  const british = u.replace(/litre/g, "liter").replace(/metre/g, "meter").replace(/gramme/g, "gram");
  if (KNOWN_UNIT_IDS.has(british)) return british;
  u = british;
  // Named synonyms the table has no row for.
  const SYNONYMS = { "mechanical-horsepower": "horsepower", "imperial-horsepower": "horsepower", "metric-ton": "tonnes", "metric-tons": "tonnes" };
  if (SYNONYMS[u] && KNOWN_UNIT_IDS.has(SYNONYMS[u])) return SYNONYMS[u];
  // Singular -> plural, including the first segment of "x-per-y" ("btu-per-hour" -> "btus-per-hour").
  const IRREGULAR = { foot: "feet", inch: "inches" };
  const plurals = (w) => [IRREGULAR[w], w + "s", w + "es"].filter(Boolean);
  const per = u.indexOf("-per-");
  const candidates = per > 0
    ? plurals(u.slice(0, per)).map((head) => head + u.slice(per))
    : plurals(u);
  for (const c of candidates) if (KNOWN_UNIT_IDS.has(c)) return c;
  return null;
}

function convertUnit(value, from, to) {
  const resolve = (u) => {
    const key = String(u).toLowerCase();
    const a = UNIT_ALIASES[key] ?? (KNOWN_UNIT_IDS.has(key) ? key : normalizeUnitId(key) ?? key);
    return Array.isArray(a) ? a : [a, 1];
  };
  const [fromId, fromScale] = resolve(from);
  const [toId, toScale] = resolve(to);
  return convertAnyUnit(value * fromScale, fromId, toId) / toScale;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)).toFixed(6);
}

const math = [
  {
    route: "POST /api/calc", name: "Calculator", slug: "calc", aliases: ["divide", "fraction", "divided-by", "calculate", "calculator"], category: "math", price: "$0.001",
    description: "Safely evaluate an arithmetic expression (+ - * / % ^ and parentheses). No code execution - a real parser, not eval.",
    tags: ["calc", "math", "expression", "arithmetic"],
    discovery: { bodyType: "json", input: { expr: "2 + 3 * (4 - 1) ^ 2" }, inputSchema: { properties: { expr: { type: "string" } }, required: ["expr"] }, output: { example: { result: 29 } } },
    handler: (i) => {
      // Accept any reasonable "expression" alias — analytics shows callers send `expression` / `formula`.
      const raw = i.expr ?? i.expression ?? i.formula;
      if (typeof raw !== "string" || !raw) {
        throw bad('Missing "expr". Send {"expr":"2 + 3 * 4"} - alternate fields expression/formula are also accepted.');
      }
      return { result: evalExpr(cap(raw, 1000, "expr").trim()) };
    },
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
    route: "POST /api/unit-convert", name: "Unit convert", slug: "unit-convert", aliases: ["kilometres", "metres", "litres", "statute-miles", "horsepower", "kilowatts", "altitude", "elevation"], category: "math", price: "$0.001",
    description: "Convert a value between units of length, mass, temperature, volume, area, speed, time, data, pressure, energy, power, angle, frequency - every unit the retired convert-* endpoints handled (e.g. miles, kilometers, kilograms, pounds, stones, us-gallons, liters, fahrenheit, psi, bar, kilopascals, kilowatt-hours, joules, btu, horsepower, and imperial Russian versts, sazhens, arshins, poods and funts).",
    // The category tags are joined by the most-queried unit words so lexical
    // search surfaces ("convert miles to kilometers" via /api/find and the MCP
    // search_tools) rank this tool where the retired pairwise convert-* slugs
    // used to match. The full unit tail is handled by the unit-word synonym
    // expansion in src/find.js (built from UNIT_CATEGORIES + UNIT_ALIASES).
    tags: ["units", "convert", "length", "mass", "temperature", "volume", "area", "speed", "time", "data", "pressure", "energy", "power", "angle", "frequency",
      "miles", "kilometers", "meters", "feet", "kilograms", "pounds", "celsius", "fahrenheit", "liters", "gallons"],
    discovery: {
      bodyType: "json",
      input: { value: 100, from: "fahrenheit", to: "celsius" },
      inputSchema: { properties: {
        value: { type: "number" },
        from: { type: "string", description: 'Source unit id - any unit of length, mass, temperature, volume, area, speed, time, data, pressure, energy, power, angle, or frequency (e.g. "miles", "fahrenheit", "us-gallons"). Short aliases like "km"/"lb"/"f" also work.' },
        to: { type: "string", description: "Target unit id - must be in the same category as `from`." },
      }, required: ["value", "from", "to"] },
      output: { example: { result: 37.7777777778, from: "fahrenheit", to: "celsius" } },
    },
    handler: (i) => {
      const value = Number(need(i, "value", "any"));
      if (!Number.isFinite(value)) throw bad('"value" must be a number');
      return { result: +convertUnit(value, need(i, "from"), need(i, "to")).toPrecision(12), from: i.from, to: i.to };
    },
  },
  {
    route: "POST /api/percentage", name: "Percentage", slug: "percentage", aliases: ["fraction", "proportion"], category: "math", price: "$0.001",
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
    route: "POST /api/cidr", name: "CIDR calculator", slug: "cidr", category: "math", price: "$0.001",
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
    route: "POST /api/finance", name: "Finance", slug: "finance", category: "math", price: "$0.001",
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
      // Anchor-and-clamp: add whole months to the birth date (clamping the day to
      // the target month's length, so Jan 31 + 1mo = Feb 28/29), back off if we
      // overshot `now`, then the remainder is the day count. The old subtract-and-
      // borrow approach produced NEGATIVE days when the birth-day exceeded the
      // borrow month's length (e.g. born the 31st, measured into a short month).
      const addMonths = (d, m) => {
        const mo = d.getUTCMonth() + m;
        const ty = d.getUTCFullYear() + Math.floor(mo / 12);
        const tm = ((mo % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
        return new Date(Date.UTC(ty, tm, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
      };
      let totalMonths = (now.getUTCFullYear() - b.getUTCFullYear()) * 12 + (now.getUTCMonth() - b.getUTCMonth());
      if (addMonths(b, totalMonths) > now) totalMonths--;
      const anchor = addMonths(b, totalMonths);
      const years = Math.floor(totalMonths / 12);
      const months = totalMonths % 12;
      const days = Math.floor((now - anchor) / 86400000);
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
  {
    route: "POST /api/json-schema-infer", name: "JSON Schema infer", slug: "json-schema-infer", category: "validation", price: "$0.001",
    description:
      "Infer a draft-07 JSON Schema from sample JSON document(s). Send one sample as json, or several as samples. Heuristic merge rules: required = keys present in every sample, conflicting types become a type union, integer widens to number, and string formats (date-time, date, email, uri, uuid) are detected from values. Complements json-validate.",
    tags: ["json", "schema", "infer", "draft-07", "validate", "generate"],
    discovery: {
      bodyType: "json",
      input: { json: { name: "Ada", age: 36, active: true, tags: ["pioneer"], joined: "1843-10-18" } },
      inputSchema: {
        properties: {
          json: { description: "a sample JSON document (object or JSON string)" },
          samples: { type: "array", description: "alternative: 1-50 sample documents merged into one schema" },
        },
      },
      output: { example: { schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { name: { type: "string" }, age: { type: "integer" } }, required: ["name", "age"] }, samples: 1 } },
    },
    handler: (i) => {
      let samples;
      if (Array.isArray(i.samples)) samples = i.samples.map((s, k) => parseMaybeJson(s, `samples[${k}]`));
      else if ("json" in i) samples = [parseMaybeJson(i.json, "json")];
      else throw bad('Provide "json" (a sample document) or "samples" (an array of sample documents)');
      if (!samples.length || samples.length > 50) throw bad('"samples" must contain 1-50 documents');
      if (JSON.stringify(samples).length > 300_000) throw bad("sample JSON exceeds 300000 characters");
      let schema = null;
      for (const s of samples) schema = mergeInferred(schema, inferSchema(s, 0));
      return { schema: { $schema: "http://json-schema.org/draft-07/schema#", ...schema }, samples: samples.length };
    },
  },
];

// --- json-schema-infer helpers ---------------------------------------------
const STRING_FORMATS = [
  ["date-time", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["time", /^\d{2}:\d{2}:\d{2}(\.\d+)?$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/],
  ["uri", /^https?:\/\/\S+$/],
];
function inferSchema(value, depth) {
  if (depth > 24) return {};
  if (value === null || value === undefined) return { type: "null" };
  const t = typeof value;
  if (t === "boolean") return { type: "boolean" };
  if (t === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (t === "string") {
    const fmt = STRING_FORMATS.find(([, re]) => re.test(value));
    return fmt ? { type: "string", format: fmt[0] } : { type: "string" };
  }
  if (Array.isArray(value)) {
    let items = null;
    for (const el of value.slice(0, 200)) items = mergeInferred(items, inferSchema(el, depth + 1));
    return items ? { type: "array", items } : { type: "array" };
  }
  if (t === "object") {
    const keys = Object.keys(value).slice(0, 500);
    const properties = {};
    for (const k of keys) properties[k] = inferSchema(value[k], depth + 1);
    const out = { type: "object", properties };
    if (keys.length) out.required = keys;
    return out;
  }
  return {};
}
function mergeInferred(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = a.type, tb = b.type;
  if (ta === tb && !Array.isArray(ta)) {
    if (ta === "object") {
      const properties = { ...(a.properties || {}) };
      for (const [k, v] of Object.entries(b.properties || {})) properties[k] = properties[k] ? mergeInferred(properties[k], v) : v;
      const required = (a.required || []).filter((k) => (b.required || []).includes(k));
      const out = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }
    if (ta === "array") {
      const items = a.items && b.items ? mergeInferred(a.items, b.items) : a.items || b.items;
      return items ? { type: "array", items } : { type: "array" };
    }
    if (ta === "string") return a.format && a.format === b.format ? { type: "string", format: a.format } : { type: "string" };
    return { type: ta };
  }
  const flat = (t) => (Array.isArray(t) ? t : [t]);
  const types = [...new Set([...flat(ta), ...flat(tb)])];
  if (types.length === 2 && types.includes("integer") && types.includes("number")) return { type: "number" };
  return { type: types.sort() };
}

export const KIT2 = [...encoding, ...text, ...conversion, ...math, ...time, ...validation];
