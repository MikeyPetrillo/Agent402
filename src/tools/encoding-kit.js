// Encoding kit — Punycode IDN, NATO phonetic alphabet, Soundex phonetic
// hash, binary-text converter, Braille Unicode. All pure-CPU, no network,
// no npm deps — proof-of-work eligible (free tier).
import { domainToASCII, domainToUnicode } from "node:url";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ---------------------------------------------------------------------------
// NATO phonetic alphabet
// ---------------------------------------------------------------------------
const NATO_MAP = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo",
  F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet",
  K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar",
  P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango",
  U: "Uniform", V: "Victor", W: "Whiskey", X: "Xray", Y: "Yankee",
  Z: "Zulu",
  "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
  "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Niner",
};
const NATO_REV = Object.fromEntries(Object.entries(NATO_MAP).map(([k, v]) => [v.toUpperCase(), k]));

// ---------------------------------------------------------------------------
// Soundex (American Soundex, NARA algorithm)
// ---------------------------------------------------------------------------
const SOUNDEX_MAP = {
  B: "1", F: "1", P: "1", V: "1",
  C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
  D: "3", T: "3",
  L: "4",
  M: "5", N: "5",
  R: "6",
};

function soundex(word) {
  const upper = word.toUpperCase().replace(/[^A-Z]/g, "");
  if (!upper) return "0000";
  let result = upper[0];
  let prev = SOUNDEX_MAP[upper[0]] || "0";
  for (let i = 1; i < upper.length && result.length < 4; i++) {
    const code = SOUNDEX_MAP[upper[i]];
    if (code && code !== prev) { result += code; }
    prev = code || (upper[i] === "H" || upper[i] === "W" ? prev : "0");
  }
  return result.padEnd(4, "0");
}

// ---------------------------------------------------------------------------
// Braille Unicode mapping (Grade 1, letters + digits + common punctuation)
// ---------------------------------------------------------------------------
const BRAILLE_MAP = {
  a: "\u2801", b: "\u2803", c: "\u2809", d: "\u2819", e: "\u2811",
  f: "\u280B", g: "\u281B", h: "\u2813", i: "\u280A", j: "\u281A",
  k: "\u2805", l: "\u2807", m: "\u280D", n: "\u281D", o: "\u2815",
  p: "\u280F", q: "\u281F", r: "\u2817", s: "\u280E", t: "\u281E",
  u: "\u2825", v: "\u2827", w: "\u283A", x: "\u282D", y: "\u283D",
  z: "\u2835",
  "1": "\u2801", "2": "\u2803", "3": "\u2809", "4": "\u2819", "5": "\u2811",
  "6": "\u280B", "7": "\u281B", "8": "\u2813", "9": "\u280A", "0": "\u281A",
  " ": " ", ".": "\u2832", ",": "\u2802", "?": "\u2826", "!": "\u2816",
  "-": "\u2824", ":": "\u2812", ";": "\u2806", "'": "\u2804",
};
const NUM_PREFIX = "\u283C"; // number indicator
const BRAILLE_REV = {};
for (const [k, v] of Object.entries(BRAILLE_MAP)) {
  if (k >= "a" && k <= "z") BRAILLE_REV[v] = k;
}
// Punctuation reverse
for (const ch of [" ", ".", ",", "?", "!", "-", ":", ";", "'"]) {
  BRAILLE_REV[BRAILLE_MAP[ch]] = ch;
}

function toBraille(text) {
  const lower = text.toLowerCase();
  const parts = [];
  let inNum = false;
  for (const ch of lower) {
    if (ch >= "0" && ch <= "9") {
      if (!inNum) { parts.push(NUM_PREFIX); inNum = true; }
      parts.push(BRAILLE_MAP[ch] || ch);
    } else {
      inNum = false;
      parts.push(BRAILLE_MAP[ch] || ch);
    }
  }
  return parts.join("");
}

function fromBraille(braille) {
  const chars = [...braille];
  const parts = [];
  let inNum = false;
  for (const ch of chars) {
    if (ch === NUM_PREFIX) { inNum = true; continue; }
    if (ch === " ") { inNum = false; parts.push(" "); continue; }
    if (inNum) {
      // Number: braille digits map to 1-9,0 (same cells as a-j)
      const letter = BRAILLE_REV[ch];
      if (letter) {
        const idx = letter.charCodeAt(0) - 97; // a=0, b=1, ..., j=9
        if (idx >= 0 && idx <= 9) { parts.push(String((idx + 1) % 10)); continue; }
      }
      inNum = false;
    }
    const mapped = BRAILLE_REV[ch];
    parts.push(mapped || ch);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
export const ENCODING_TOOLS = [
  // 1. Punycode convert
  {
    route: "POST /api/punycode-convert", name: "Punycode convert", slug: "punycode-convert",
    category: "encoding", price: "$0.001",
    description:
      "Convert an internationalized domain name to Punycode (ASCII-compatible encoding, RFC 3492) or decode Punycode back to Unicode. Uses Node.js built-in IDNA support. Deterministic, pure CPU.",
    tags: ["punycode", "domain", "idn"],
    discovery: {
      input: { domain: "münchen.de" },
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Domain name to encode (Unicode) or decode (Punycode)" },
          decode: { type: "boolean", description: "If true, decode from Punycode to Unicode (default: false)" },
        },
        required: ["domain"],
      },
      output: { example: { result: "xn--mnchen-3ya.de", mode: "encode", original: "münchen.de", labels: ["xn--mnchen-3ya", "de"] } },
    },
    handler(input) {
      if (!input.domain && input.domain !== "") throw bad('Missing "domain"');
      const domain = String(input.domain).trim();
      if (!domain) throw bad('"domain" must not be empty');
      if (input.decode) {
        const decoded = domainToUnicode(domain);
        if (!decoded) throw bad(`Failed to decode Punycode domain "${domain}"`);
        return { result: decoded, mode: "decode", original: domain, labels: decoded.split(".") };
      }
      const encoded = domainToASCII(domain);
      if (!encoded) throw bad(`Failed to encode domain "${domain}" to Punycode`);
      return { result: encoded, mode: "encode", original: domain, labels: encoded.split(".") };
    },
  },

  // 2. NATO phonetic alphabet
  {
    route: "POST /api/nato-phonetic", name: "NATO phonetic alphabet", slug: "nato-phonetic",
    category: "encoding", price: "$0.001",
    description:
      "Convert text to the NATO phonetic alphabet (Alpha, Bravo, Charlie...) or decode phonetic words back to text. Letters and digits supported. Word boundaries marked with \" | \". Deterministic, pure CPU.",
    tags: ["nato", "phonetic", "alphabet"],
    discovery: {
      input: { text: "SOS 42" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to encode, or NATO phonetic string to decode" },
          decode: { type: "boolean", description: "If true, decode NATO phonetic words back to text (default: false)" },
        },
        required: ["text"],
      },
      output: { example: { result: "Sierra Oscar Sierra | Four Two", mode: "encode", original: "SOS 42" } },
    },
    handler(input) {
      if (!input.text && input.text !== "") throw bad('Missing "text"');
      const text = String(input.text);
      if (input.decode) {
        const groups = text.split(/\s*\|\s*/);
        const decoded = groups.map((group) => {
          const words = group.trim().split(/\s+/);
          return words.map((w) => {
            const ch = NATO_REV[w.toUpperCase()];
            if (!ch) throw bad(`Unknown NATO phonetic word "${w}"`);
            return ch;
          }).join("");
        }).join(" ");
        return { result: decoded, mode: "decode", original: text };
      }
      const upper = text.toUpperCase();
      const wordGroups = upper.split(/\s+/);
      const encoded = wordGroups.map((word) => {
        return [...word].map((ch) => {
          const phonetic = NATO_MAP[ch];
          if (!phonetic) throw bad(`No NATO phonetic mapping for character "${ch}"`);
          return phonetic;
        }).join(" ");
      }).join(" | ");
      return { result: encoded, mode: "encode", original: text };
    },
  },

  // 3. Soundex phonetic hash
  {
    route: "POST /api/soundex", name: "Soundex hash", slug: "soundex",
    category: "encoding", price: "$0.001",
    description:
      "Compute the American Soundex (NARA) phonetic hash code for one or more words. Soundex maps similar-sounding names to the same 4-character code (letter + 3 digits). Useful for fuzzy name matching. Deterministic, pure CPU.",
    tags: ["soundex", "phonetic", "hash"],
    discovery: {
      input: { text: "Robert Rupert" },
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "one or more words to hash (space-separated)" } },
        required: ["text"],
      },
      output: { example: { codes: [{ word: "Robert", soundex: "R163" }, { word: "Rupert", soundex: "R163" }], match: true } },
    },
    handler(input) {
      if (!input.text || typeof input.text !== "string") throw bad('Missing or invalid "text"');
      const words = input.text.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) throw bad('"text" must contain at least one word');
      const codes = words.map((w) => ({ word: w, soundex: soundex(w) }));
      const allSame = codes.every((c) => c.soundex === codes[0].soundex);
      return { codes, match: codes.length > 1 && allSame };
    },
  },

  // 4. Binary-text converter
  {
    route: "POST /api/binary-text", name: "Binary text", slug: "binary-text",
    category: "encoding", price: "$0.001",
    description:
      "Convert text to its binary (base-2) representation (8-bit per character, space-separated) or decode binary back to text. Deterministic, pure CPU.",
    tags: ["binary", "encode", "decode"],
    discovery: {
      input: { text: "Hi" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "text to encode, or space-separated binary string to decode" },
          decode: { type: "boolean", description: "If true, decode binary to text (default: false)" },
        },
        required: ["text"],
      },
      output: { example: { result: "01001000 01101001", mode: "encode", original: "Hi" } },
    },
    handler(input) {
      if (!input.text && input.text !== "") throw bad('Missing "text"');
      const text = String(input.text);
      if (input.decode) {
        const bytes = text.trim().split(/\s+/);
        const decoded = bytes.map((b) => {
          if (!/^[01]{1,8}$/.test(b)) throw bad(`Invalid binary byte "${b}"`);
          return String.fromCharCode(parseInt(b, 2));
        }).join("");
        return { result: decoded, mode: "decode", original: text };
      }
      const encoded = [...text].map((ch) => ch.charCodeAt(0).toString(2).padStart(8, "0")).join(" ");
      return { result: encoded, mode: "encode", original: text };
    },
  },

  // 5. Braille Unicode converter
  {
    route: "POST /api/braille-convert", name: "Braille convert", slug: "braille-convert",
    category: "encoding", price: "$0.001",
    description:
      "Convert text to Unicode Braille characters (Grade 1 / uncontracted) or decode Braille back to text. Supports letters, digits, and common punctuation. Deterministic, pure CPU.",
    tags: ["braille", "unicode", "accessibility"],
    discovery: {
      input: { text: "hello" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "text to encode, or Braille Unicode string to decode" },
          decode: { type: "boolean", description: "If true, decode Braille to text (default: false)" },
        },
        required: ["text"],
      },
      output: { example: { result: "\u2813\u2811\u2807\u2807\u2815", mode: "encode", original: "hello" } },
    },
    handler(input) {
      if (!input.text && input.text !== "") throw bad('Missing "text"');
      const text = String(input.text);
      if (input.decode) {
        const decoded = fromBraille(text);
        return { result: decoded, mode: "decode", original: text };
      }
      const encoded = toBraille(text);
      return { result: encoded, mode: "encode", original: text };
    },
  },
];
