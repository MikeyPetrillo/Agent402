// Parse kit: small readers for text an agent holds and needs as data.
//   number-words    English number words to digits, and digits to words
//   encoding-detect try the common text encodings on a string and rank the decodings
//   log-timestamps  find the timestamps in log text and write each as ISO UTC
//   csv-aggregate   count, sum, mean, min, max and distinct per CSV column, optional group-by
//   json-lint       the first JSON syntax error with line, column, offset and excerpt
// All pure CPU: no network, no key, no model -> proof-of-work eligible
// (src/free-tier.js). Every reader is one pass over a capped input.
import { gunzipSync, inflateSync } from "node:zlib";
import { parseCsv, csvDelimiterOf } from "./kit.js";
import { partialFields } from "../partial-answer.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// A string field, capped. A number is read as its decimal text where `numbers` allows it.
function textField(input, name, { max, required = true, numbers = false, allowEmpty = false } = {}) {
  let v = input?.[name];
  if (numbers && typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (allowEmpty && v === "") return v;
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`"${name}" is required`);
    return null;
  }
  if (typeof v !== "string") throw bad(`"${name}" must be a string`);
  if (v.length > max) throw bad(`"${name}" exceeds ${max} characters`);
  return v;
}

function intField(input, name, { min, max, dflt }) {
  const v = input?.[name];
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${name}" must be a whole number from ${min} to ${max}`);
  return n;
}

function flagField(input, name, dflt) {
  const v = input?.[name];
  if (v === undefined || v === null || v === "") return dflt;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw bad(`"${name}" must be true or false`);
}

// ============================================================================
// number-words
// ============================================================================
const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [["thousand", 1e3], ["million", 1e6], ["billion", 1e9], ["trillion", 1e12], ["quadrillion", 1e15]];
const ORD_UNITS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];
const ORD_TENS = ["", "", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth"];

const WORD = new Map();
UNITS.forEach((w, n) => WORD.set(w, { kind: "unit", n }));
TENS.forEach((w, n) => { if (w) WORD.set(w, { kind: "ten", n: n * 10 }); });
WORD.set("hundred", { kind: "hundred", n: 100 });
for (const [w, n] of SCALES) WORD.set(w, { kind: "scale", n });
ORD_UNITS.forEach((w, n) => WORD.set(w, { kind: "unit", n, ordinal: true }));
ORD_TENS.forEach((w, n) => { if (w) WORD.set(w, { kind: "ten", n: n * 10, ordinal: true }); });
WORD.set("hundredth", { kind: "hundred", n: 100, ordinal: true });
for (const [w, n] of SCALES) WORD.set(`${w}th`, { kind: "scale", n, ordinal: true });
WORD.set("fourty", WORD.get("forty"));
WORD.set("ninty", WORD.get("ninety"));
WORD.set("oh", { kind: "unit", n: 0, digitOnly: true });

const NUMBER_WORDS_MAX = 500;
const NUMBER_WORDS_TOKENS = 80;
const MAX_INT = BigInt(Number.MAX_SAFE_INTEGER);
const DIGITS_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

function ordinalSuffix(n) {
  const s = n % 100n;
  if (s >= 11n && s <= 13n) return "th";
  return ["th", "st", "nd", "rd"][Number(n % 10n)] || "th";
}

// Words for 0..999.
function under1000(n) {
  const parts = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(`${UNITS[h]} hundred`);
  if (r) parts.push(r < 20 ? UNITS[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${UNITS[r % 10]}` : ""));
  return parts.join(" ");
}

// Cardinal words for a non-negative BigInt up to MAX_INT.
function intWords(n) {
  if (n === 0n) return "zero";
  const groups = [];
  let x = n;
  while (x > 0n) { groups.push(Number(x % 1000n)); x /= 1000n; }
  const out = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    out.push(under1000(groups[i]) + (i ? ` ${SCALES[i - 1][0]}` : ""));
  }
  return out.join(" ");
}

function ordinalWords(cardinal) {
  const m = cardinal.match(/^(.*?)([a-z]+)$/);
  const [, head, last] = m;
  const u = UNITS.indexOf(last);
  if (u >= 0) return head + ORD_UNITS[u];
  const t = TENS.indexOf(last);
  if (t >= 2) return head + ORD_TENS[t];
  return `${head}${last}th`;
}

function digitsToWords(raw) {
  const s = raw.trim().replace(/,/g, "");
  const neg = s.startsWith("-");
  const [intPart, frac = ""] = s.replace(/^[-+]/, "").split(".");
  const n = BigInt(intPart);
  if (n > MAX_INT) throw bad(`"text" is past the largest number this tool writes (${Number.MAX_SAFE_INTEGER.toLocaleString("en-US")})`);
  if (frac.length > 15) throw bad('"text" has more than 15 digits after the decimal point');
  let words = intWords(n);
  if (frac) words += " point " + [...frac].map((d) => UNITS[+d]).join(" ");
  if (neg && (n > 0n || /[1-9]/.test(frac))) words = `minus ${words}`;
  const digits = (neg && (n > 0n || /[1-9]/.test(frac)) ? "-" : "") + n.toString() + (frac ? `.${frac}` : "");
  const out = { input: raw, direction: "digits-to-words", digits, number: Number(digits), words };
  if (!frac) {
    out.ordinal = (neg && n > 0n ? "minus " : "") + ordinalWords(intWords(n));
    out.ordinalDigits = (neg && n > 0n ? "-" : "") + n.toString() + ordinalSuffix(n);
  }
  if (!neg && frac.length <= 2) {
    const cents = (frac + "00").slice(0, 2);
    const w = intWords(n);
    out.check = `${w[0].toUpperCase()}${w.slice(1)} and ${cents}/100`;
  }
  return out;
}

function wordsToDigits(raw) {
  const tokens = raw.toLowerCase().replace(/[\u2010-\u2015-]/g, " ").replace(/,/g, " ").trim().split(/\s+/);
  if (tokens.length > NUMBER_WORDS_TOKENS) throw bad(`"text" has more than ${NUMBER_WORDS_TOKENS} words`);
  let i = 0, neg = false;
  if (tokens[0] === "minus" || tokens[0] === "negative") { neg = true; i = 1; }
  let total = 0n, group = 0n, lastScale = 0n, prev = null, ordinal = false, any = false;
  let frac = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (frac !== null) {
      const w = WORD.get(t);
      if (/^\d+$/.test(t)) frac += t;
      else if (w && w.kind === "unit" && w.n < 10 && !w.ordinal) frac += String(w.n);
      else throw bad(`"text": after "point" only digits or the words zero to nine may follow, not "${t}"`);
      continue;
    }
    if (t === "and") { if (prev) continue; throw bad('"text" cannot start with "and"'); }
    if (t === "point" || t === "dot") { frac = ""; continue; }
    if (t === "a" && !prev) { group = 1n; prev = "unit"; any = true; continue; }
    if (ordinal) throw bad(`"text": nothing may follow the ordinal word before "${t}"`);
    let w = WORD.get(t);
    if (!w && /^\d{1,3}$/.test(t)) w = { kind: "unit", n: Number(t), numeral: true };
    if (!w) throw bad(`"text" holds a word that is not a number word: "${t.slice(0, 40)}"`);
    if (w.digitOnly) throw bad(`"text": "${t}" is read only after "point"`);
    const n = BigInt(w.n);
    if (w.kind === "unit") {
      if (w.numeral && (prev === "unit" || prev === "ten")) throw bad(`"text": "${t}" cannot follow another number word`);
      if (prev === "unit" || (prev === "ten" && (w.n >= 10 || w.n === 0)) || (prev === "hundred" && group % 100n !== 0n)) throw bad(`"text": "${t}" cannot follow the word before it`);
      group += n;
    } else if (w.kind === "ten") {
      if (prev === "unit" || prev === "ten" || (prev === "hundred" && group % 100n !== 0n)) throw bad(`"text": "${t}" cannot follow the word before it`);
      group += n;
    } else if (w.kind === "hundred") {
      if (prev === "scale" || group >= 100n) throw bad(`"text": "hundred" cannot follow "${tokens[i - 1]}"`);
      group = (group || 1n) * 100n;
    } else {
      if (lastScale && n >= lastScale) throw bad(`"text": "${t}" cannot follow a larger or equal scale word`);
      if (group >= 1000n) throw bad(`"text": the group before "${t}" is over 999`);
      total += (group || 1n) * n;
      group = 0n;
      lastScale = n;
    }
    prev = w.kind;
    any = true;
    if (w.ordinal) ordinal = true;
  }
  if (!any && frac === null) throw bad('"text" holds no number words');
  if (frac === "") throw bad('"text": "point" must be followed by digits');
  if (frac !== null && ordinal) throw bad('"text": an ordinal cannot have a decimal part');
  if (frac !== null && frac.length > 15) throw bad('"text" has more than 15 digits after the decimal point');
  const n = total + group;
  if (n > MAX_INT) throw bad(`"text" is past the largest number this tool reads (${Number.MAX_SAFE_INTEGER.toLocaleString("en-US")})`);
  const sign = neg && (n > 0n || (frac && /[1-9]/.test(frac))) ? "-" : "";
  const digits = sign + n.toString() + (frac !== null ? `.${frac}` : "");
  const out = { input: raw, direction: "words-to-digits", digits, number: Number(digits) };
  out.formatted = sign + n.toLocaleString("en-US") + (frac !== null ? `.${frac}` : "");
  out.ordinal = ordinal;
  if (ordinal) out.ordinalDigits = sign + n.toString() + ordinalSuffix(n);
  out.words = (sign ? "minus " : "") + intWords(n) + (frac !== null ? " point " + [...frac].map((d) => UNITS[+d]).join(" ") : "");
  return out;
}

// ============================================================================
// encoding-detect
// ============================================================================
const DETECT_MAX = 100_000;
const DETECT_TEXT_MAX = 2_000;
const INFLATE_MAX = 1_000_000;
const BASE58_TRY_MAX = 1_024;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(s) {
  const clean = s.replace(/=+$/, "").toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function decodeBase58(s) {
  let x = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    x = x * 58n + BigInt(v);
  }
  let hex = x === 0n ? "" : x.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

function decodePercent(s) {
  const bytes = [];
  let escapes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; escapes++; }
    else if (c === "+") bytes.push(0x20);
    else bytes.push(...Buffer.from(c, "utf8"));
  }
  return escapes ? Buffer.from(bytes) : null;
}

function decodeQuotedPrintable(s) {
  const bytes = [];
  let escapes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" && /^[0-9A-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; escapes++; }
    else if (c === "=" && (s[i + 1] === "\n" || (s[i + 1] === "\r" && s[i + 2] === "\n"))) { i += s[i + 1] === "\r" ? 2 : 1; escapes++; }
    else if (c === "=") return null;
    else bytes.push(...Buffer.from(c, "utf8"));
  }
  return escapes ? Buffer.from(bytes) : null;
}

// How much of the bytes reads as text: UTF-8 when it decodes cleanly, else Latin-1 bytes.
function readBytes(buf) {
  let text, validUtf8 = true;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { validUtf8 = false; text = buf.toString("latin1"); }
  let printable = 0, total = 0;
  for (const ch of text) {
    total++;
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0x7f) || (validUtf8 && c >= 0xa0 && c !== 0xfffd)) printable++;
  }
  return { text, validUtf8, printableRatio: total ? printable / total : 0 };
}

function inflateLayer(buf) {
  if (buf.length >= 18 && buf[0] === 0x1f && buf[1] === 0x8b) return { layer: "gzip", fn: gunzipSync };
  if (buf.length >= 6 && buf[0] === 0x78 && ((buf[0] << 8) | buf[1]) % 31 === 0) return { layer: "zlib", fn: inflateSync };
  return null;
}

const ENCODING_FIT = { "url": 1, "quoted-printable": 0.95, "hex": 0.95, "base64": 0.9, "base64url": 0.9, "base32": 0.85, "base58": 0.75 };

function detectEncodings(raw) {
  const s = raw.trim();
  const compact = s.replace(/\s+/g, "");
  const tries = [];
  const hexBody = compact.replace(/^0x/i, "").replace(/[:-]/g, "");
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length % 2 === 0) tries.push(["hex", Buffer.from(hexBody, "hex")]);
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.replace(/=+$/, "").length % 4 !== 1) {
    tries.push(["base64", Buffer.from(compact, "base64")]);
  }
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(compact) && /[_-]/.test(compact) && compact.replace(/=+$/, "").length % 4 !== 1) {
    tries.push(["base64url", Buffer.from(compact.replace(/=+$/, ""), "base64url")]);
  }
  if ((/^[A-Z2-7]+=*$/.test(compact) || /^[a-z2-7]+=*$/.test(compact)) && [0, 2, 4, 5, 7].includes(compact.replace(/=+$/, "").length % 8)) {
    const b = decodeBase32(compact);
    if (b) tries.push(["base32", b]);
  }
  if (compact.length <= BASE58_TRY_MAX && /^[1-9A-HJ-NP-Za-km-z]+$/.test(compact)) {
    const b = decodeBase58(compact);
    if (b) tries.push(["base58", b]);
  }
  if (s.includes("%")) { const b = decodePercent(s); if (b) tries.push(["url", b]); }
  if (s.includes("=")) { const b = decodeQuotedPrintable(s); if (b) tries.push(["quoted-printable", b]); }

  const candidates = [];
  for (const [encoding, first] of tries) {
    if (!first.length) continue;
    let buf = first, name = encoding, layerNote = null;
    const layer = inflateLayer(first);
    if (layer) {
      try {
        buf = layer.fn(first, { maxOutputLength: INFLATE_MAX });
        name = `${encoding}+${layer.layer}`;
      } catch (e) {
        if (e?.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) layerNote = `${layer.layer} data inflates past ${INFLATE_MAX} bytes; shown undecompressed`;
      }
    }
    const read = readBytes(buf);
    const base = ENCODING_FIT[encoding] ?? 0.8;
    const confidence = Math.round(read.printableRatio * base * (read.validUtf8 ? 1 : 0.6) * (name.includes("+") ? 1.05 : 1) * 100) / 100;
    const row = { encoding: name, confidence: Math.min(confidence, 1), printableRatio: Math.round(read.printableRatio * 1000) / 1000, validUtf8: read.validUtf8, bytes: buf.length };
    if (read.validUtf8 && read.printableRatio >= 0.5) {
      row.text = read.text.slice(0, DETECT_TEXT_MAX);
      row.textTruncated = read.text.length > DETECT_TEXT_MAX;
    } else {
      row.hexPreview = buf.subarray(0, 64).toString("hex");
      row.textTruncated = buf.length > 64;
    }
    if (layerNote) row.note = layerNote;
    candidates.push(row);
  }
  candidates.sort((a, b) => b.confidence - a.confidence || b.printableRatio - a.printableRatio);
  return { input: raw.length > 200 ? `${raw.slice(0, 200)}...` : raw, inputChars: raw.length, count: candidates.length, best: candidates[0]?.encoding ?? null, candidates };
}

// ============================================================================
// log-timestamps
// ============================================================================
const LOG_MAX = 100_000;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const ZONE_ABBR = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };
// One alternation, every branch fixed-width or bounded, tried left to right.
const STAMP_RE = new RegExp([
  // ISO 8601 and the space- or slash-separated forms of it
  `(?<iso>\\b(?<iy>\\d{4})(?<is>[-/])(?<im>\\d{2})\\k<is>(?<id>\\d{2})[T ](?<ih>\\d{2}):(?<imi>\\d{2})(?::(?<isec>\\d{2})(?:[.,](?<ifr>\\d{1,9}))?)?(?<iz>Z|[+-]\\d{2}(?::?\\d{2})?\\b)?)`,
  // Apache / nginx common log format
  `(?<clf>\\b(?<cd>\\d{2})/(?<cm>${MONS})/(?<cy>\\d{4}):(?<ch>\\d{2}):(?<cmi>\\d{2}):(?<cs>\\d{2})(?: (?<cz>[+-]\\d{4}))?)`,
  // RFC 2822 (day name optional)
  `(?<rfc>\\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ?)?(?<rd>\\d{1,2}) (?<rm>${MONS}) (?<ry>\\d{4}) (?<rh>\\d{2}):(?<rmi>\\d{2})(?::(?<rs>\\d{2}))?(?: (?<rz>[+-]\\d{4}|UTC|UT|GMT|[ECMP][SD]T|Z)\\b)?)`,
  // syslog (RFC 3164): no year
  `(?<sys>\\b(?<sm>${MONS}) (?<sd>[ \\d]\\d) (?<sh>\\d{2}):(?<smi>\\d{2}):(?<ss>\\d{2})(?:\\.(?<sfr>\\d{1,6}))?\\b)`,
  // epoch milliseconds, then seconds (with an optional fraction)
  `(?<ems>\\b\\d{13}\\b)`,
  `(?<es>\\b\\d{10}(?:\\.\\d{1,6})?\\b)`,
].join("|"), "g");
const EPOCH_MIN_MS = Date.UTC(2000, 0, 1), EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

// One formatter per zone, kept (building one costs far more than using it):
// a log in a non-UTC zone converts every stamp twice. Bounded: past the cap
// the oldest zone is dropped.
const ZONE_FORMATTERS = new Map();
const ZONE_FORMATTERS_MAX = 64;
function zoneFormatter(tz) {
  let f = ZONE_FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    if (ZONE_FORMATTERS.size >= ZONE_FORMATTERS_MAX) ZONE_FORMATTERS.delete(ZONE_FORMATTERS.keys().next().value);
    ZONE_FORMATTERS.set(tz, f);
  }
  return f;
}
function zoneOffsetMinutes(utcMs, tz) {
  const parts = {};
  for (const p of zoneFormatter(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60000);
}

// Wall-clock fields read in `tz` to the instant they name.
function wallToUtc(y, mo, d, h, mi, s, ms, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (tz === "UTC") return asUtc;
  const first = asUtc - zoneOffsetMinutes(asUtc, tz) * 60000;
  return asUtc - zoneOffsetMinutes(first, tz) * 60000;
}

function validFields(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function offsetOf(z) {
  if (!z) return null;
  if (Object.hasOwn(ZONE_ABBR, z)) return ZONE_ABBR[z];
  const m = z.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (!m) return null;
  const v = +m[2] * 60 + +(m[3] || 0);
  return m[1] === "-" ? -v : v;
}

function readStamp(g, tz, year) {
  const frac = (f) => (f ? Math.floor(Number(`0.${f}`) * 1000) : 0);
  let f, zone, format;
  if (g.iso) {
    format = "iso8601";
    f = [+g.iy, +g.im, +g.id, +g.ih, +g.imi, +(g.isec || 0), frac(g.ifr)];
    zone = g.iz;
  } else if (g.clf) {
    format = "clf";
    f = [+g.cy, MON[g.cm.toLowerCase()], +g.cd, +g.ch, +g.cmi, +g.cs, 0];
    zone = g.cz;
  } else if (g.rfc) {
    format = "rfc2822";
    f = [+g.ry, MON[g.rm.toLowerCase()], +g.rd, +g.rh, +g.rmi, +(g.rs || 0), 0];
    zone = g.rz;
  } else if (g.sys) {
    format = "syslog";
    f = [year, MON[g.sm.toLowerCase()], +g.sd.trim(), +g.sh, +g.smi, +g.ss, frac(g.sfr)];
  } else {
    const ms = g.ems ? Number(g.ems) : Math.round(Number(g.es) * 1000);
    if (ms < EPOCH_MIN_MS || ms >= EPOCH_MAX_MS) return false; // a number, not a stamp
    return { format: g.ems ? "epoch-ms" : "epoch-seconds", ms, zoneSource: "epoch" };
  }
  if (!validFields(...f.slice(0, 6))) return null;
  if (f[5] === 60) f[5] = 59;
  const off = offsetOf(zone);
  if (zone && off === null) return null;
  if (off !== null) return { format, ms: Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5], f[6]) - off * 60000, zoneSource: "stamp" };
  return { format, ms: wallToUtc(...f, tz), zoneSource: "assumed" };
}

function logTimestamps(text, tz, year, limit, epoch = true) {
  const stamps = [];
  let matched = 0, skipped = 0, line = 1, lineStart = 0, scanned = 0;
  let prevMs = null, outOfOrder = 0, gap = null, first = null, last = null, minMs = Infinity, maxMs = -Infinity;
  STAMP_RE.lastIndex = 0;
  for (let m = STAMP_RE.exec(text); m; m = STAMP_RE.exec(text)) {
    for (; scanned < m.index; scanned++) if (text.charCodeAt(scanned) === 10) { line++; lineStart = scanned + 1; }
    if (!epoch && (m.groups.ems || m.groups.es)) continue;
    const r = readStamp(m.groups, tz, year);
    if (r === false) continue;
    if (!r || !Number.isFinite(r.ms)) { skipped++; continue; }
    matched++;
    if (prevMs !== null) {
      if (r.ms < prevMs) outOfOrder++;
      else if (!gap || r.ms - prevMs > gap.seconds * 1000) gap = { seconds: (r.ms - prevMs) / 1000, endsAtLine: line };
    }
    prevMs = r.ms;
    minMs = Math.min(minMs, r.ms); maxMs = Math.max(maxMs, r.ms);
    const row = { line, column: m.index - lineStart + 1, start: m.index, end: m.index + m[0].length, text: m[0], format: r.format, iso: new Date(r.ms).toISOString(), epochMs: r.ms, zone: r.zoneSource };
    if (!first) first = row.iso;
    last = row.iso;
    if (stamps.length < limit) stamps.push(row);
  }
  return {
    assumedZone: tz, count: matched, skippedInvalid: skipped,
    first, last,
    earliest: matched ? new Date(minMs).toISOString() : null,
    latest: matched ? new Date(maxMs).toISOString() : null,
    spanSeconds: matched ? (maxMs - minMs) / 1000 : null,
    outOfOrder, largestGap: gap,
    ...partialFields(matched, stamps.length),
    timestamps: stamps,
  };
}

// ============================================================================
// csv-aggregate
// ============================================================================
const CSV_AGG_MAX = 100_000;
const CSV_AGG_COLS = 200;
const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const NUM_COMMAS_RE = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const tidy = (x) => (Number.isFinite(x) ? Number(x.toPrecision(15)) : null);

function numberOf(v) {
  const s = v.trim();
  if (s.length > 40) return null;
  if (NUM_RE.test(s)) return Number(s);
  if (NUM_COMMAS_RE.test(s)) return Number(s.replace(/,/g, ""));
  return null;
}

function newStats() { return { count: 0, empty: 0, distinct: new Set(), numeric: 0, sum: 0, min: Infinity, max: -Infinity }; }
function addStat(st, v) {
  if (v.trim() === "") { st.empty++; return; }
  st.count++;
  st.distinct.add(v);
  const n = numberOf(v);
  if (n !== null && Number.isFinite(n)) { st.numeric++; st.sum += n; if (n < st.min) st.min = n; if (n > st.max) st.max = n; }
}
function finishStats(st) {
  const out = { count: st.count, empty: st.empty, distinct: st.distinct.size, numeric: st.numeric };
  if (st.numeric) Object.assign(out, { sum: tidy(st.sum), mean: tidy(st.sum / st.numeric), min: st.min, max: st.max });
  return out;
}

function headerNames(row) {
  const seen = new Map();
  return row.map((h, i) => {
    const base = h.trim() || `column${i + 1}`;
    const k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    return k === 1 ? base : `${base} (${k})`;
  });
}

function listField(input, name) {
  const v = input?.[name];
  if (v === undefined || v === null || v === "") return null;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list || list.length > CSV_AGG_COLS || !list.every((x) => typeof x === "string" && x.length <= 200)) throw bad(`"${name}" must be a list of column names (or a comma-separated string), at most ${CSV_AGG_COLS}`);
  return list.map((x) => x.trim()).filter(Boolean);
}

function csvAggregate(input) {
  const text = textField(input, "csv", { max: CSV_AGG_MAX });
  const { delimiter, note: delimiterNote } = csvDelimiterOf(input.delimiter);
  const grid = parseCsv(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
  if (!grid.length) throw bad('"csv" is empty');
  const header = headerNames(grid[0]);
  if (header.length > CSV_AGG_COLS) throw bad(`"csv" has more than ${CSV_AGG_COLS} columns`);
  const want = listField(input, "columns");
  const groupBy = input?.groupBy === undefined || input?.groupBy === null || input?.groupBy === "" ? null : textField(input, "groupBy", { max: 200 }).trim();
  const idx = (name, field) => {
    const i = header.indexOf(name);
    if (i < 0) throw bad(`"${field}" names a column the CSV does not have: "${name.slice(0, 80)}" (columns: ${header.slice(0, 20).join(", ")})`);
    return i;
  };
  const cols = want ? want.map((c) => idx(c, "columns")) : header.map((_, i) => i).filter((i) => header[i] !== groupBy);
  const g = groupBy ? idx(groupBy, "groupBy") : -1;
  const limit = intField(input, "limit", { min: 1, max: 1000, dflt: 100 });
  const rows = grid.slice(1);
  const overall = cols.map(() => newStats());
  const groups = new Map();
  for (const r of rows) {
    let bucket = null;
    if (g >= 0) {
      const key = r[g] ?? "";
      bucket = groups.get(key);
      if (!bucket) { bucket = { key, rows: 0, stats: cols.map(() => newStats()) }; groups.set(key, bucket); }
      bucket.rows++;
    }
    cols.forEach((c, k) => {
      const v = r[c] ?? "";
      addStat(overall[k], v);
      if (bucket) addStat(bucket.stats[k], v);
    });
  }
  const statsOf = (list) => Object.fromEntries(cols.map((c, k) => [header[c], finishStats(list[k])]));
  const out = { rows: rows.length, delimiter, ...(delimiterNote ? { delimiterNote } : {}), columns: statsOf(overall) };
  if (g >= 0) {
    const all = [...groups.values()].sort((a, b) => b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const shown = all.slice(0, limit);
    out.groupBy = header[g];
    Object.assign(out, partialFields(all.length, shown.length));
    out.groups = shown.map((b) => ({ key: b.key, rows: b.rows, columns: statsOf(b.stats) }));
  }
  return out;
}

// ============================================================================
// json-lint
// ============================================================================
const LINT_MAX = 100_000;
const DUP_MAX = 100;
// A duplicate's key is listed up to DUP_KEY_MAX characters (keyTruncated and
// keyLength say when it was cut); a path names each key up to PATH_KEY_MAX
// characters and stops at PATH_MAX (pathTruncated).
const DUP_KEY_MAX = 200;
const PATH_KEY_MAX = 64;
const PATH_MAX = 300;

class LintError extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

function describeChar(text, i) {
  if (i >= text.length) return "the end of the input";
  const c = text[i];
  if (c === "\n") return "a line break";
  if (c.charCodeAt(0) < 0x20) return `control character U+${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
  return `"${c}"`;
}

// An iterative JSON reader (RFC 8259), one pass, an explicit stack in place of recursion.
function lintJson(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++; else break; } };
  const fail = (msg, at = i) => { throw new LintError(msg, at); };
  const unexpected = (what) => {
    const c = text[i];
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) fail("JSON does not allow comments");
    if (c === "'") fail("JSON strings use double quotes, not single quotes");
    fail(`Expected ${what} but found ${describeChar(text, i)}`);
  };
  const readString = () => {
    const start = i;
    i++;
    let s = "";
    let runStart = i;
    while (true) {
      if (i >= n) fail("Unterminated string", start);
      const c = text.charCodeAt(i);
      if (c === 0x22) { s += text.slice(runStart, i); i++; return s; }
      if (c < 0x20) fail(`Unescaped ${describeChar(text, i)} inside a string`);
      if (c === 0x5c) {
        s += text.slice(runStart, i);
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("Invalid \\u escape: it needs four hex digits");
          s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          s += { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
          i += 2;
        } else fail(`Invalid escape \\${e ?? ""} in a string`);
        runStart = i;
        continue;
      }
      i++;
    }
  };
  const readNumber = () => {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (text[i] >= "1" && text[i] <= "9") while (text[i] >= "0" && text[i] <= "9") i++;
    else fail(`Invalid number: expected a digit after "-"`, i);
    if (text[i] === ".") { i++; if (!(text[i] >= "0" && text[i] <= "9")) fail("Invalid number: expected a digit after the decimal point"); while (text[i] >= "0" && text[i] <= "9") i++; }
    if (text[i] === "e" || text[i] === "E") { i++; if (text[i] === "+" || text[i] === "-") i++; if (!(text[i] >= "0" && text[i] <= "9")) fail("Invalid number: expected a digit in the exponent"); while (text[i] >= "0" && text[i] <= "9") i++; }
    if (text[start] === "0" || (text[start] === "-" && text[start + 1] === "0")) { if (text[i] >= "0" && text[i] <= "9") fail("Invalid number: a leading zero is not allowed"); }
  };
  const word = (w) => { if (text.startsWith(w, i)) { i += w.length; return true; } return false; };
  // stack frames: { type: "object"|"array", keys?: Set, key?: string, index: number, open: offset }
  const stack = [];
  const dups = [];
  let dupCount = 0, maxDepth = 0, rootType = null;
  // A path names each key up to PATH_KEY_MAX characters and is cut at
  // PATH_MAX, so a long key cannot repeat into every duplicate's path.
  const keyPart = (k) => {
    const cut = k.length > PATH_KEY_MAX ? k.slice(0, PATH_KEY_MAX) : k;
    if (cut === k && /^[A-Za-z_$][\w$]*$/.test(k)) return `.${k}`;
    return `[${JSON.stringify(cut)}${cut === k ? "" : "..."}]`;
  };
  const pathInfo = () => {
    let p = "$", cut = false;
    for (const f of stack) {
      if (f.type === "object" && f.key !== undefined && f.key.length > PATH_KEY_MAX) cut = true;
      p += f.type === "array" ? `[${f.index}]` : f.key === undefined ? "" : keyPart(f.key);
      if (p.length > PATH_MAX) { p = p.slice(0, PATH_MAX - 3) + "..."; cut = true; break; }
    }
    return { path: p, cut };
  };
  const pathOf = () => pathInfo().path;
  // An object key, its duplicate check and the colon after it.
  const readKey = (f) => {
    const at = i;
    const k = readString();
    f.key = k;
    if (f.keys.has(k)) {
      dupCount++;
      if (dups.length < DUP_MAX) {
        const { path, cut } = pathInfo();
        dups.push({ key: k.length > DUP_KEY_MAX ? k.slice(0, DUP_KEY_MAX) : k, ...(k.length > DUP_KEY_MAX ? { keyTruncated: true, keyLength: k.length } : {}), offset: at, path, ...(cut ? { pathTruncated: true } : {}) });
      }
    }
    f.keys.add(k);
    ws();
    if (text[i] !== ":") unexpected('":" after the object key');
    i++;
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  ws();
  // state: "value" (expecting a value), "after" (a value just ended)
  let state = "value";
  try {
    while (true) {
      if (state === "value") {
        ws();
        const c = text[i];
        let type;
        if (c === "{") {
          stack.push({ type: "object", keys: new Set(), open: i, index: 0 });
          maxDepth = Math.max(maxDepth, stack.length);
          i++; ws();
          if (text[i] === "}") { i++; stack.pop(); type = "object"; }
          else if (text[i] === '"') { readKey(stack[stack.length - 1]); continue; }
          else if (text[i] === "]" || text[i] === ",") fail(`Expected a string key or "}" but found ${describeChar(text, i)}`);
          else unexpected('a string key or "}"');
        } else if (c === "[") {
          stack.push({ type: "array", open: i, index: 0 });
          maxDepth = Math.max(maxDepth, stack.length);
          i++; ws();
          if (text[i] !== "]") continue;
          i++; stack.pop(); type = "array";
        } else if (c === '"') { readString(); type = "string"; }
        else if (c === "-" || (c >= "0" && c <= "9")) { readNumber(); type = "number"; }
        else if (word("true") || word("false")) type = "boolean";
        else if (word("null")) type = "null";
        else if (i >= n) fail(stack.length ? `Unexpected end of input: ${stack.length} unclosed ${stack.length === 1 ? "bracket" : "brackets"}` : "Empty input: no JSON value");
        else if (c === "}") fail("Expected a value but found \"}\"");
        else if (/[A-Za-z]/.test(c)) { let j = i; while (j < n && j - i < 20 && /[A-Za-z]/.test(text[j])) j++; fail(`Unexpected word "${text.slice(i, j)}": JSON allows only true, false and null without quotes`); }
        else unexpected("a value");
        if (!rootType && !stack.length) rootType = type;
        state = "after";
        continue;
      }
      // after a value
      ws();
      if (!stack.length) {
        if (i < n) fail(`Unexpected ${describeChar(text, i)} after the end of the JSON value`);
        break;
      }
      const f = stack[stack.length - 1];
      const c = text[i];
      if (c === ",") {
        i++; ws();
        if (f.type === "array") { f.index++; if (text[i] === "]") fail('Trailing comma before "]"'); state = "value"; continue; }
        if (text[i] === "}") fail('Trailing comma before "}"');
        if (text[i] !== '"') unexpected("a string key");
        readKey(f);
        state = "value"; continue;
      }
      if ((c === "}" && f.type === "object") || (c === "]" && f.type === "array")) {
        i++; stack.pop();
        if (!stack.length && !rootType) rootType = f.type;
        state = "after"; continue;
      }
      if (i >= n) fail(`Unexpected end of input: ${stack.length} unclosed ${stack.length === 1 ? "bracket" : "brackets"} (the innermost opened at offset ${f.open})`);
      if (c === "}" || c === "]") fail(`Mismatched "${c}": the innermost open bracket is "${f.type === "object" ? "{" : "["}" at offset ${f.open}`);
      fail(`Expected "," or "${f.type === "object" ? "}" : "]"}" after ${f.type === "object" ? "an object value" : "an array element"} but found ${describeChar(text, i)}`);
    }
  } catch (e) {
    if (!(e instanceof LintError)) throw e;
    return { valid: false, error: { message: e.message, offset: e.offset, path: pathOf() }, dupCount, dups };
  }
  return { valid: true, type: rootType ?? (stack.length ? null : "unknown"), maxDepth, dupCount, dups };
}

// Line and column (1-based) of each offset, in one pass over the text.
function positionsOf(text, offsets) {
  const order = offsets.map((o, k) => [o, k]).sort((a, b) => a[0] - b[0]);
  const out = new Array(offsets.length);
  let line = 1, lineStart = 0, p = 0;
  for (const [o, k] of order) {
    for (; p < o && p < text.length; p++) if (text.charCodeAt(p) === 10) { line++; lineStart = p + 1; }
    out[k] = { line, column: o - lineStart + 1, lineStart };
  }
  return out;
}

function excerptAt(text, offset, lineStart) {
  let end = text.indexOf("\n", offset);
  if (end < 0) end = text.length;
  const from = Math.max(lineStart, offset - 40);
  const to = Math.min(end, offset + 40);
  const before = text.slice(from, offset).replace(/\t/g, " ");
  const snippet = (from > lineStart ? "..." : "") + before + text.slice(offset, to).replace(/[\r\t]/g, " ") + (to < end ? "..." : "");
  return { excerpt: snippet, pointer: " ".repeat((from > lineStart ? 3 : 0) + before.length) + "^" };
}

function jsonLint(text) {
  const r = lintJson(text);
  const offsets = [...r.dups.map((d) => d.offset)];
  if (!r.valid) offsets.push(r.error.offset);
  const pos = positionsOf(text, offsets);
  const duplicateKeys = r.dups.map((d, k) => ({ key: d.key, ...(d.keyTruncated ? { keyTruncated: true, keyLength: d.keyLength } : {}), path: d.path, ...(d.pathTruncated ? { pathTruncated: true } : {}), line: pos[k].line, column: pos[k].column, offset: d.offset }));
  const dupFields = { duplicateKeyCount: r.dupCount, duplicateKeys, duplicateKeysTruncated: r.dupCount > duplicateKeys.length };
  if (r.valid) return { valid: true, type: r.type, maxDepth: r.maxDepth, chars: text.length, ...dupFields };
  const p = pos[pos.length - 1];
  return { valid: false, syntaxError: { message: r.error.message, line: p.line, column: p.column, offset: r.error.offset, path: r.error.path, ...excerptAt(text, r.error.offset, p.lineStart) }, chars: text.length, ...dupFields };
}

// ============================================================================
// Tool definitions
// ============================================================================
export const PARSE_TOOLS = [
  {
    route: "POST /api/number-words",
    name: "Number words",
    slug: "number-words", aliases: ["words-to-number", "number-to-words", "spell-number"],
    category: "conversion",
    price: "$0.001",
    description:
      "Read English number words as digits (\"forty-two thousand and seven\" is 42007), with ordinals (\"twenty-first\" is 21, 21st) and decimals (\"three point five\" is 3.5), or write digits as words, with the ordinal and the check-writing form (\"Forty-two thousand seven and 50/100\"). The direction follows the input: digits are written as words, words are read as digits. Whole numbers up to 9,007,199,254,740,991 and up to 15 decimal places.",
    tags: ["number", "words", "convert", "ordinal", "cardinal", "text-to-number", "spell-out", "check-writing"],
    discovery: {
      bodyType: "json",
      input: { text: "forty-two thousand and seven" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Number words (\"one hundred forty-seven\", \"twenty-first\", \"three point five\") or digits (\"42007\", \"1,250.50\"); at most 500 characters" },
        },
        required: ["text"],
      },
      output: { example: { input: "forty-two thousand and seven", direction: "words-to-digits", digits: "42007", number: 42007, formatted: "42,007", ordinal: false, words: "forty-two thousand seven" } },
    },
    handler: (input) => {
      const text = textField(input, "text", { max: NUMBER_WORDS_MAX, numbers: true });
      return DIGITS_RE.test(text.trim()) ? digitsToWords(text) : wordsToDigits(text);
    },
  },
  {
    route: "POST /api/encoding-detect",
    name: "Encoding detect",
    slug: "encoding-detect", aliases: ["detect-encoding", "identify-encoding"],
    category: "encoding",
    price: "$0.001",
    description:
      "Find out how a string is encoded. Tries hex, base64, base64url, base32, base58, URL (percent) encoding and quoted-printable, and inflates gzip or zlib data found inside (a decoded size cap guards against compression bombs). Each plausible decoding comes back ranked by confidence, from how much of it reads as text, with the decoded text (first 2,000 characters) or a hex preview of binary bytes. Input up to 100,000 characters (in a request body of at most 100 KB; JSON escaping counts, so a newline takes two bytes).",
    tags: ["encoding", "detect", "decode", "base64", "hex", "base32", "base58", "url-decode", "gzip", "identify"],
    discovery: {
      bodyType: "json",
      input: { text: "SGVsbG8sIGFnZW50IQ==" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "The encoded string (at most 100,000 characters)" },
        },
        required: ["text"],
      },
      output: { example: { input: "SGVsbG8sIGFnZW50IQ==", inputChars: 20, count: 1, best: "base64", candidates: [{ encoding: "base64", confidence: 0.9, printableRatio: 1, validUtf8: true, bytes: 13, text: "Hello, agent!", textTruncated: false }] } },
    },
    handler: (input) => detectEncodings(textField(input, "text", { max: DETECT_MAX })),
  },
  {
    route: "POST /api/log-timestamps",
    name: "Log timestamps",
    slug: "log-timestamps", aliases: ["log-time-parse", "timestamp-extract"],
    category: "time",
    price: "$0.001",
    description:
      "Find every timestamp in log text and write each as ISO 8601 UTC, with its line, column and character span in the original. Reads ISO 8601, RFC 2822, syslog, Apache and nginx access-log stamps, and epoch seconds or milliseconds (2000 to 2100). Stamps without a zone are read in assumeZone (an IANA name, default UTC); syslog stamps carry no year and take year (default the current UTC year). Also reports the first and last stamp, the span, stamps out of order and the largest gap. Text up to 100,000 characters (in a request body of at most 100 KB; JSON escaping counts, so a newline takes two bytes); up to 2,000 stamps listed.",
    tags: ["log", "timestamp", "parse", "iso8601", "syslog", "epoch", "normalize", "utc"],
    discovery: {
      bodyType: "json",
      input: { text: "2026-11-02T14:03:07Z service started\nNov  2 14:05:11 host sshd[311]: accepted\n10.0.0.5 - - [02/Nov/2026:14:06:40 +0000] \"GET / HTTP/1.1\" 200\njob done at 1793628490", assumeZone: "UTC", year: 2026 },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Log text (at most 100,000 characters)" },
          assumeZone: { type: "string", description: "IANA time zone for stamps that carry no zone or offset (default UTC)" },
          year: { type: "number", description: "Year for syslog stamps, which carry none (default the current UTC year)" },
          epoch: { type: "boolean", description: "Read 10- and 13-digit numbers as epoch seconds and milliseconds (default true)" },
          limit: { type: "number", description: "Stamps to list, 1-2000 (default 500); the summary counts every stamp" },
        },
        required: ["text"],
      },
      output: { example: { assumedZone: "UTC", count: 4, skippedInvalid: 0, first: "2026-11-02T14:03:07.000Z", last: "2026-11-02T14:08:10.000Z", earliest: "2026-11-02T14:03:07.000Z", latest: "2026-11-02T14:08:10.000Z", spanSeconds: 303, outOfOrder: 0, largestGap: { seconds: 124, endsAtLine: 2 }, returned: 4, matched: 4, complete: true, truncated: false, timestamps: [{ line: 1, column: 1, start: 0, end: 20, text: "2026-11-02T14:03:07Z", format: "iso8601", iso: "2026-11-02T14:03:07.000Z", epochMs: 1793628187000, zone: "stamp" }] } },
    },
    handler: (input) => {
      const text = textField(input, "text", { max: LOG_MAX });
      const tzRaw = textField(input, "assumeZone", { max: 64, required: false }) ?? "UTC";
      const tz = tzRaw.trim();
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw bad(`"assumeZone" is not an IANA time zone: "${tz.slice(0, 64)}" (for example America/New_York, Europe/London, UTC)`); }
      const year = intField(input, "year", { min: 1970, max: 2100, dflt: new Date().getUTCFullYear() });
      const limit = intField(input, "limit", { min: 1, max: 2000, dflt: 500 });
      const epoch = flagField(input, "epoch", true);
      return logTimestamps(text, tz, year, limit, epoch);
    },
  },
  {
    route: "POST /api/csv-aggregate",
    name: "CSV aggregate",
    slug: "csv-aggregate", aliases: ["csv-sum", "csv-group-by", "csv-distinct", "csv-stats", "csv-column-stats", "csv-average"],
    category: "data",
    price: "$0.002",
    description:
      "Summarize CSV columns: count, empty cells, distinct values, and for numbers sum, mean, min and max, over the whole table or per group with groupBy (a column name). The first row is the header. columns picks the columns to summarize (default all). Comma by default, or delimiter: semicolon, tab, pipe or any single character other than a quote or a line break. CSV up to 100,000 characters (in a request body of at most 100 KB; JSON escaping counts, so a newline takes two bytes) and 200 columns; up to 1,000 groups listed, largest first.",
    tags: ["csv", "aggregate", "group-by", "sum", "count", "mean", "average", "min", "max", "distinct", "column", "summary", "pivot"],
    discovery: {
      bodyType: "json",
      input: { csv: "region,product,units,price\nwest,widget,12,2.50\neast,widget,7,2.50\nwest,gadget,3,9.99\neast,gadget,5,9.99\nwest,widget,8,2.75\n", groupBy: "region" },
      inputSchema: {
        properties: {
          csv: { type: "string", description: "CSV text with a header row (at most 100,000 characters)" },
          groupBy: { type: "string", description: "Column to group rows by (optional)" },
          columns: { type: "array", items: { type: "string" }, description: "Columns to summarize (default every column but groupBy); a comma-separated string also works" },
          delimiter: { type: "string", description: "comma (default), semicolon, tab, pipe, or any single character other than a quote or a line break" },
          limit: { type: "number", description: "Groups to list, 1-1000 (default 100), largest first" },
        },
        required: ["csv"],
      },
      output: { example: { rows: 5, delimiter: ",", columns: { product: { count: 5, empty: 0, distinct: 2, numeric: 0 }, units: { count: 5, empty: 0, distinct: 5, numeric: 5, sum: 35, mean: 7, min: 3, max: 12 } }, groupBy: "region", returned: 2, matched: 2, complete: true, truncated: false, groups: [{ key: "west", rows: 3, columns: { units: { count: 3, empty: 0, distinct: 3, numeric: 3, sum: 23, mean: 7.66666666666667, min: 3, max: 12 } } }] } },
    },
    handler: (input) => csvAggregate(input),
  },
  {
    route: "POST /api/json-lint",
    name: "JSON lint",
    slug: "json-lint", aliases: ["json-syntax-check", "json-error-position", "json-duplicate-keys"],
    category: "data",
    price: "$0.001",
    description:
      "Check JSON text and point at the first syntax error: its line, column, character position (offset), the path in the document where it stopped, and a short excerpt with a marker under the spot, with a clear message for trailing commas, comments, single quotes, unclosed brackets and bad escapes. Also lists duplicate object keys, which JSON.parse accepts silently. A trailing comma is reported at the bracket after it; json-repair points its fix at the comma itself, one character earlier. Input up to 100,000 characters (in a request body of at most 100 KB; JSON escaping counts, so a newline takes two bytes).",
    tags: ["json", "lint", "validate", "syntax", "error", "line", "column", "duplicate-keys"],
    discovery: {
      bodyType: "json",
      input: { json: "{\n  \"name\": \"Ada\",\n  \"tags\": [\"eng\", \"math\",]\n}" },
      inputSchema: {
        properties: {
          json: { type: "string", description: "JSON text to check (at most 100,000 characters)" },
        },
        required: ["json"],
      },
      output: { example: { valid: false, syntaxError: { message: "Trailing comma before \"]\"", line: 3, column: 26, offset: 44, path: "$.tags[2]", excerpt: "  \"tags\": [\"eng\", \"math\",]", pointer: "                         ^" }, chars: 47, duplicateKeyCount: 0, duplicateKeys: [], duplicateKeysTruncated: false } },
    },
    handler: (input) => jsonLint(textField(input, "json", { max: LINT_MAX, allowEmpty: true })),
  },
];

export const _test = { wordsToDigits, digitsToWords, detectEncodings, logTimestamps, csvAggregate, jsonLint, lintJson };
