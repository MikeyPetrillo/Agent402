// The utility kit: many small, deterministic, pay-per-call tools.
// Each entry: { route, name, slug, category, price, description, tags,
//   discovery, mimeType?, handler(input) -> result | { __binary, contentType } }
// Handlers receive merged { ...query, ...body } and throw { statusCode: 400 }
// (via bad()) for invalid input.
import { createHash, createHmac, randomBytes, randomUUID, randomInt } from "node:crypto";
import { resolveMx, reverse } from "node:dns/promises";
import { isIP } from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import yaml from "js-yaml";
import { marked } from "marked";
import QRCode from "qrcode";
import { assertPublicUrl, safeFetch } from "./fetch-guard.js";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function need(input, field, type = "string") {
  const v = input[field];
  if (v === undefined || v === null || (type === "string" && typeof v !== "string"))
    throw bad(`Missing or invalid "${field}"`);
  return v;
}

function capText(text, max = 100_000, label = "text") {
  if (typeof text !== "string") throw bad(`"${label}" must be a string`);
  if (text.length > max) throw bad(`"${label}" exceeds ${max} characters`);
  return text;
}

function parseMaybeJson(value, label) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    throw bad(`"${label}" is not valid JSON: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Encoding & crypto
// ---------------------------------------------------------------------------

const HASH_ALGOS = ["sha256", "sha512", "sha1", "md5"];

const B32_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(time = Date.now()) {
  let out = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = B32_CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  for (let i = 0; i < 16; i++) out += B32_CROCKFORD[rand[i] % 32];
  return out;
}

function uuidV7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base32Decode(str) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw bad("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const encodingTools = [
  {
    route: "POST /api/hash",
    name: "Hash",
    slug: "hash",
    category: "encoding",
    price: "$0.001",
    description: "Cryptographic hash of a text string. Algorithms: sha256 (default), sha512, sha1, md5. Returns hex and base64 digests.",
    tags: ["hash", "sha256", "checksum", "crypto"],
    discovery: {
      bodyType: "json",
      input: { text: "hello world", algo: "sha256" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to hash (max 100KB)" },
          algo: { type: "string", description: "sha256 | sha512 | sha1 | md5" },
        },
        required: ["text"],
      },
      output: { example: { algo: "sha256", hex: "b94d27…", base64: "uU0n…" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"));
      const algo = (input.algo || "sha256").toLowerCase();
      if (!HASH_ALGOS.includes(algo)) throw bad(`algo must be one of: ${HASH_ALGOS.join(", ")}`);
      const h = createHash(algo).update(text);
      const buf = h.digest();
      return { algo, hex: buf.toString("hex"), base64: buf.toString("base64") };
    },
  },
  {
    route: "POST /api/hmac",
    name: "HMAC",
    slug: "hmac",
    category: "encoding",
    price: "$0.001",
    description: "HMAC signature of a message with a shared key. Algorithms: sha256 (default), sha512, sha1. Returns hex and base64.",
    tags: ["hmac", "signature", "webhook", "crypto"],
    discovery: {
      bodyType: "json",
      input: { text: "payload", key: "secret", algo: "sha256" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Message to sign (max 100KB)" },
          key: { type: "string", description: "Shared secret key" },
          algo: { type: "string", description: "sha256 | sha512 | sha1" },
        },
        required: ["text", "key"],
      },
      output: { example: { algo: "sha256", hex: "f7bc…", base64: "97w…" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"));
      const key = need(input, "key");
      const algo = (input.algo || "sha256").toLowerCase();
      if (!["sha256", "sha512", "sha1"].includes(algo)) throw bad("algo must be sha256, sha512, or sha1");
      const buf = createHmac(algo, key).update(text).digest();
      return { algo, hex: buf.toString("hex"), base64: buf.toString("base64") };
    },
  },
  {
    route: "POST /api/base64",
    name: "Base64",
    slug: "base64",
    category: "encoding",
    price: "$0.001",
    description: "Base64 encode or decode text. mode: encode (default) or decode. Handles URL-safe base64 on decode.",
    tags: ["base64", "encode", "decode"],
    discovery: {
      bodyType: "json",
      input: { text: "hello", mode: "encode" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Input text (max 100KB)" },
          mode: { type: "string", description: "encode | decode" },
        },
        required: ["text"],
      },
      output: { example: { mode: "encode", result: "aGVsbG8=" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"));
      const mode = input.mode === "decode" ? "decode" : "encode";
      if (mode === "encode") return { mode, result: Buffer.from(text, "utf8").toString("base64") };
      const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(normalized, "base64");
      return { mode, result: decoded.toString("utf8") };
    },
  },
  {
    route: "POST /api/hex",
    name: "Hex",
    slug: "hex",
    category: "encoding",
    price: "$0.001",
    description: "Hex encode or decode text. mode: encode (default) or decode.",
    tags: ["hex", "encode", "decode"],
    discovery: {
      bodyType: "json",
      input: { text: "hi", mode: "encode" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Input text (max 100KB)" },
          mode: { type: "string", description: "encode | decode" },
        },
        required: ["text"],
      },
      output: { example: { mode: "encode", result: "6869" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"));
      const mode = input.mode === "decode" ? "decode" : "encode";
      if (mode === "encode") return { mode, result: Buffer.from(text, "utf8").toString("hex") };
      if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2) throw bad("Not a valid hex string");
      return { mode, result: Buffer.from(text, "hex").toString("utf8") };
    },
  },
  {
    route: "POST /api/url-code",
    name: "URL encode/decode",
    slug: "url-code",
    category: "encoding",
    price: "$0.001",
    description: "Percent-encode or decode a string for URLs. mode: encode (default) or decode. component: true (default) uses encodeURIComponent semantics.",
    tags: ["url", "percent-encoding", "encode", "decode"],
    discovery: {
      bodyType: "json",
      input: { text: "a b&c", mode: "encode" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Input text (max 100KB)" },
          mode: { type: "string", description: "encode | decode" },
          component: { type: "boolean", description: "Use component encoding (default true)" },
        },
        required: ["text"],
      },
      output: { example: { mode: "encode", result: "a%20b%26c" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"));
      const mode = input.mode === "decode" ? "decode" : "encode";
      const component = input.component !== false && input.component !== "false";
      try {
        const result =
          mode === "encode"
            ? component
              ? encodeURIComponent(text)
              : encodeURI(text)
            : component
              ? decodeURIComponent(text)
              : decodeURI(text);
        return { mode, result };
      } catch {
        throw bad("Malformed percent-encoding");
      }
    },
  },
  {
    route: "POST /api/jwt-decode",
    name: "JWT decode",
    slug: "jwt-decode",
    category: "encoding",
    price: "$0.001",
    description: "Decode a JWT without verification: header, payload, expiry status, and time remaining. (Decoding only — signatures are NOT verified.)",
    tags: ["jwt", "token", "auth", "decode"],
    discovery: {
      bodyType: "json",
      input: { token: "eyJhbGciOi…" },
      inputSchema: {
        properties: { token: { type: "string", description: "The JWT string" } },
        required: ["token"],
      },
      output: { example: { header: { alg: "HS256" }, payload: { sub: "123", exp: 1760000000 }, expired: false, expiresInSeconds: 3600 } },
    },
    handler: (input) => {
      const token = capText(need(input, "token"), 16_384, "token");
      const parts = token.split(".");
      if (parts.length < 2) throw bad("Not a JWT (expected at least 2 dot-separated segments)");
      const decode = (seg) => {
        try {
          return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        } catch {
          throw bad("JWT segment is not valid base64url JSON");
        }
      };
      const header = decode(parts[0]);
      const payload = decode(parts[1]);
      const now = Math.floor(Date.now() / 1000);
      const expired = typeof payload.exp === "number" ? payload.exp < now : null;
      return {
        header,
        payload,
        signaturePresent: parts.length === 3 && parts[2].length > 0,
        verified: false,
        expired,
        expiresInSeconds: typeof payload.exp === "number" ? payload.exp - now : null,
      };
    },
  },
  {
    route: "GET /api/uuid",
    name: "UUID generator",
    slug: "uuid",
    category: "identifiers",
    price: "$0.001",
    description: "Generate UUIDs. ?version=4 (default, random) or 7 (time-ordered), ?count=1..100.",
    tags: ["uuid", "id", "generator"],
    discovery: {
      input: { version: "7", count: "3" },
      inputSchema: {
        properties: {
          version: { type: "string", description: "4 (random) or 7 (time-ordered)" },
          count: { type: "string", description: "How many (1-100, default 1)" },
        },
      },
      output: { example: { version: 7, uuids: ["0190a1b2-…"] } },
    },
    handler: (input) => {
      const version = String(input.version || "4");
      if (!["4", "7"].includes(version)) throw bad("version must be 4 or 7");
      const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 100);
      const gen = version === "7" ? uuidV7 : randomUUID;
      return { version: Number(version), uuids: Array.from({ length: count }, () => gen()) };
    },
  },
  {
    route: "GET /api/ulid",
    name: "ULID generator",
    slug: "ulid",
    category: "identifiers",
    price: "$0.001",
    description: "Generate ULIDs (sortable, timestamp-prefixed identifiers). ?count=1..100.",
    tags: ["ulid", "id", "generator", "sortable"],
    discovery: {
      input: { count: "3" },
      inputSchema: { properties: { count: { type: "string", description: "How many (1-100, default 1)" } } },
      output: { example: { ulids: ["01J9ZK7M3N…"] } },
    },
    handler: (input) => {
      const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 100);
      return { ulids: Array.from({ length: count }, () => ulid()) };
    },
  },
  {
    route: "GET /api/password",
    name: "Password generator",
    slug: "password",
    category: "identifiers",
    price: "$0.001",
    description: "Generate cryptographically random passwords. ?length=8..128 (default 24), ?symbols=true|false (default true), ?count=1..20.",
    tags: ["password", "random", "generator", "security"],
    discovery: {
      input: { length: "32", symbols: "true", count: "1" },
      inputSchema: {
        properties: {
          length: { type: "string", description: "8-128, default 24" },
          symbols: { type: "string", description: "Include symbols (default true)" },
          count: { type: "string", description: "How many (1-20, default 1)" },
        },
      },
      output: { example: { passwords: ["k9#mP2…"], entropyBits: 190 } },
    },
    handler: (input) => {
      const length = Math.min(Math.max(parseInt(input.length, 10) || 24, 8), 128);
      const symbols = input.symbols !== "false" && input.symbols !== false;
      const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 20);
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" + (symbols ? "!@#$%^&*()-_=+[]{}<>?" : "");
      const make = () => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
      return {
        passwords: Array.from({ length: count }, make),
        entropyBits: Math.floor(length * Math.log2(alphabet.length)),
      };
    },
  },
  {
    route: "GET /api/random",
    name: "Random",
    slug: "random",
    category: "identifiers",
    price: "$0.001",
    description: "Cryptographically secure randomness. ?bytes=1..1024 returns hex; or ?min=&max= returns a uniform integer; ?count=1..100.",
    tags: ["random", "entropy", "dice"],
    discovery: {
      input: { min: "1", max: "100", count: "3" },
      inputSchema: {
        properties: {
          bytes: { type: "string", description: "Return N random bytes as hex (1-1024)" },
          min: { type: "string", description: "Integer lower bound (inclusive)" },
          max: { type: "string", description: "Integer upper bound (inclusive)" },
          count: { type: "string", description: "How many values (1-100, default 1)" },
        },
      },
      output: { example: { integers: [42, 7, 93] } },
    },
    handler: (input) => {
      const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 100);
      if (input.bytes !== undefined) {
        const n = Math.min(Math.max(parseInt(input.bytes, 10) || 16, 1), 1024);
        return { hex: Array.from({ length: count }, () => randomBytes(n).toString("hex")) };
      }
      const min = parseInt(input.min, 10);
      const max = parseInt(input.max, 10);
      if (Number.isNaN(min) || Number.isNaN(max) || max <= min) throw bad("Provide ?bytes= or integer ?min= and ?max= with max > min");
      return { integers: Array.from({ length: count }, () => randomInt(min, max + 1)) };
    },
  },
  {
    route: "POST /api/totp",
    name: "TOTP code",
    slug: "totp",
    category: "encoding",
    price: "$0.002",
    description: "Compute the current TOTP code (RFC 6238, 30s period, SHA-1, 6 digits) from a base32 secret. Useful for agents that must complete 2FA flows they are authorized for.",
    tags: ["totp", "2fa", "otp", "authentication"],
    discovery: {
      bodyType: "json",
      input: { secret: "JBSWY3DPEHPK3PXP" },
      inputSchema: {
        properties: {
          secret: { type: "string", description: "Base32 TOTP secret" },
          digits: { type: "number", description: "6 (default) or 8" },
        },
        required: ["secret"],
      },
      output: { example: { code: "492039", secondsRemaining: 17 } },
    },
    handler: (input) => {
      const secret = need(input, "secret");
      const digits = input.digits === 8 || input.digits === "8" ? 8 : 6;
      const key = base32Decode(secret);
      const counter = Math.floor(Date.now() / 1000 / 30);
      const msg = Buffer.alloc(8);
      msg.writeBigUInt64BE(BigInt(counter));
      const digest = createHmac("sha1", key).update(msg).digest();
      const offset = digest[digest.length - 1] & 0x0f;
      const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
      return {
        code: String(code).padStart(digits, "0"),
        secondsRemaining: 30 - (Math.floor(Date.now() / 1000) % 30),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Data conversion
// ---------------------------------------------------------------------------

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function xmlNodeToJson(node) {
  const children = [...node.children];
  const attrs = {};
  for (const a of node.attributes ?? []) attrs[a.name] = a.value;
  const base = Object.keys(attrs).length ? { _attrs: attrs } : {};
  if (!children.length) {
    const text = node.textContent.trim();
    return Object.keys(base).length ? { ...base, _text: text } : text;
  }
  const out = { ...base };
  for (const child of children) {
    const val = xmlNodeToJson(child);
    if (out[child.tagName] === undefined) out[child.tagName] = val;
    else {
      if (!Array.isArray(out[child.tagName])) out[child.tagName] = [out[child.tagName]];
      out[child.tagName].push(val);
    }
  }
  return out;
}

function deepDiff(a, b, path = "", out = []) {
  if (out.length >= 1000) return out;
  if (a === b) return out;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) {
    out.push({ path: path || "(root)", type: "changed", a, b });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in a)) out.push({ path: p, type: "added", b: b[k] });
    else if (!(k in b)) out.push({ path: p, type: "removed", a: a[k] });
    else deepDiff(a[k], b[k], p, out);
  }
  return out;
}

const dataTools = [
  {
    route: "POST /api/json-format",
    name: "JSON validate & format",
    slug: "json-format",
    category: "conversion",
    price: "$0.001",
    description: "Validate, pretty-print, or minify JSON. Returns parse errors with position when invalid.",
    tags: ["json", "format", "validate", "minify"],
    discovery: {
      bodyType: "json",
      input: { json: '{"a":1}', indent: 2 },
      inputSchema: {
        properties: {
          json: { type: "string", description: "JSON text to validate/format (max 100KB)" },
          indent: { type: "number", description: "Spaces of indentation; 0 = minify (default 2)" },
        },
        required: ["json"],
      },
      output: { example: { valid: true, formatted: '{\n  "a": 1\n}' } },
    },
    handler: (input) => {
      const text = capText(need(input, "json"), 100_000, "json");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { valid: false, error: e.message };
      }
      const indent = input.indent === undefined ? 2 : Math.min(Math.max(parseInt(input.indent, 10) || 0, 0), 8);
      return { valid: true, formatted: JSON.stringify(parsed, null, indent || undefined) };
    },
  },
  {
    route: "POST /api/json-to-csv",
    name: "JSON to CSV",
    slug: "json-to-csv",
    category: "conversion",
    price: "$0.002",
    description: "Convert a JSON array of objects to CSV. Nested objects are flattened to dot-path columns.",
    tags: ["json", "csv", "convert", "spreadsheet"],
    discovery: {
      bodyType: "json",
      input: { json: [{ name: "Ada", role: { title: "Engineer" } }] },
      inputSchema: {
        properties: {
          json: { description: "Array of objects (or a JSON string of one)" },
          delimiter: { type: "string", description: "Default ," },
        },
        required: ["json"],
      },
      output: { example: { csv: "name,role.title\nAda,Engineer\n", rows: 1, columns: 2 } },
    },
    handler: (input) => {
      const data = parseMaybeJson(need(input, "json", "any"), "json");
      if (!Array.isArray(data) || !data.length) throw bad('"json" must be a non-empty array of objects');
      if (data.length > 10_000) throw bad("Max 10000 rows");
      const delimiter = typeof input.delimiter === "string" && input.delimiter.length === 1 ? input.delimiter : ",";
      const flat = data.map((row) => flatten(row && typeof row === "object" ? row : { value: row }));
      const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
      const lines = [columns.map(csvEscape).join(delimiter)];
      for (const r of flat) lines.push(columns.map((c) => csvEscape(r[c])).join(delimiter));
      return { csv: lines.join("\n") + "\n", rows: data.length, columns: columns.length };
    },
  },
  {
    route: "POST /api/csv-to-json",
    name: "CSV to JSON",
    slug: "csv-to-json",
    category: "conversion",
    price: "$0.002",
    description: "Parse CSV (quoted fields supported) into a JSON array of objects, using the first row as headers (header=false for arrays).",
    tags: ["csv", "json", "convert", "parse"],
    discovery: {
      bodyType: "json",
      input: { csv: "name,age\nAda,36\n" },
      inputSchema: {
        properties: {
          csv: { type: "string", description: "CSV text (max 100KB)" },
          delimiter: { type: "string", description: "Default ," },
          header: { type: "boolean", description: "First row is headers (default true)" },
        },
        required: ["csv"],
      },
      output: { example: { rows: [{ name: "Ada", age: "36" }], count: 1 } },
    },
    handler: (input) => {
      const text = capText(need(input, "csv"), 100_000, "csv");
      const delimiter = typeof input.delimiter === "string" && input.delimiter.length === 1 ? input.delimiter : ",";
      const grid = parseCsv(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
      if (!grid.length) throw bad("Empty CSV");
      const header = input.header !== false && input.header !== "false";
      if (!header) return { rows: grid, count: grid.length };
      const cols = grid[0];
      const rows = grid.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
      return { rows, count: rows.length };
    },
  },
  {
    route: "POST /api/yaml-to-json",
    name: "YAML to JSON",
    slug: "yaml-to-json",
    category: "conversion",
    price: "$0.002",
    description: "Parse YAML into JSON (safe schema — no code execution).",
    tags: ["yaml", "json", "convert", "config"],
    discovery: {
      bodyType: "json",
      input: { yaml: "name: Ada\ntags:\n  - eng" },
      inputSchema: {
        properties: { yaml: { type: "string", description: "YAML text (max 100KB)" } },
        required: ["yaml"],
      },
      output: { example: { json: { name: "Ada", tags: ["eng"] } } },
    },
    handler: (input) => {
      const text = capText(need(input, "yaml"), 100_000, "yaml");
      try {
        return { json: yaml.load(text, { schema: yaml.JSON_SCHEMA }) ?? null };
      } catch (e) {
        throw bad(`YAML parse error: ${e.message.split("\n")[0]}`);
      }
    },
  },
  {
    route: "POST /api/json-to-yaml",
    name: "JSON to YAML",
    slug: "json-to-yaml",
    category: "conversion",
    price: "$0.002",
    description: "Convert JSON to YAML.",
    tags: ["json", "yaml", "convert", "config"],
    discovery: {
      bodyType: "json",
      input: { json: { name: "Ada", tags: ["eng"] } },
      inputSchema: {
        properties: { json: { description: "Any JSON value (or a JSON string of one)" } },
        required: ["json"],
      },
      output: { example: { yaml: "name: Ada\ntags:\n  - eng\n" } },
    },
    handler: (input) => {
      const data = parseMaybeJson(need(input, "json", "any"), "json");
      return { yaml: yaml.dump(data, { lineWidth: 120 }) };
    },
  },
  {
    route: "POST /api/xml-to-json",
    name: "XML to JSON",
    slug: "xml-to-json",
    category: "conversion",
    price: "$0.002",
    description: "Parse XML into a JSON object tree (attributes under _attrs, text under _text; repeated elements become arrays).",
    tags: ["xml", "json", "convert", "parse"],
    discovery: {
      bodyType: "json",
      input: { xml: "<user id='1'><name>Ada</name></user>" },
      inputSchema: {
        properties: { xml: { type: "string", description: "XML text (max 100KB)" } },
        required: ["xml"],
      },
      output: { example: { json: { user: { _attrs: { id: "1" }, name: "Ada" } } } },
    },
    handler: (input) => {
      const text = capText(need(input, "xml"), 100_000, "xml");
      const dom = new JSDOM("");
      const doc = new dom.window.DOMParser().parseFromString(text, "text/xml");
      if (doc.querySelector("parsererror")) throw bad("XML parse error");
      const root = doc.documentElement;
      return { json: { [root.tagName]: xmlNodeToJson(root) } };
    },
  },
  {
    route: "POST /api/markdown-to-html",
    name: "Markdown to HTML",
    slug: "markdown-to-html",
    category: "conversion",
    price: "$0.002",
    description: "Render CommonMark + GFM markdown to HTML.",
    tags: ["markdown", "html", "convert", "render"],
    discovery: {
      bodyType: "json",
      input: { markdown: "# Hi\n\n**bold**" },
      inputSchema: {
        properties: { markdown: { type: "string", description: "Markdown text (max 100KB)" } },
        required: ["markdown"],
      },
      output: { example: { html: "<h1>Hi</h1>\n<p><strong>bold</strong></p>\n" } },
    },
    handler: (input) => {
      const text = capText(need(input, "markdown"), 100_000, "markdown");
      return { html: marked.parse(text, { async: false }) };
    },
  },
  {
    route: "POST /api/html-to-markdown",
    name: "HTML to Markdown",
    slug: "html-to-markdown",
    category: "conversion",
    price: "$0.002",
    description: "Convert an HTML fragment or document you already have into clean markdown. (To fetch + convert a live URL, use /api/extract.)",
    tags: ["html", "markdown", "convert"],
    discovery: {
      bodyType: "json",
      input: { html: "<h1>Hi</h1><p><b>bold</b></p>" },
      inputSchema: {
        properties: { html: { type: "string", description: "HTML text (max 100KB)" } },
        required: ["html"],
      },
      output: { example: { markdown: "# Hi\n\n**bold**" } },
    },
    handler: (input) => {
      const text = capText(need(input, "html"), 100_000, "html");
      const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      return { markdown: td.turndown(text) };
    },
  },
  {
    route: "POST /api/json-diff",
    name: "JSON diff",
    slug: "json-diff",
    category: "conversion",
    price: "$0.002",
    description: "Deep-compare two JSON values. Returns a list of changed/added/removed paths (capped at 1000 differences).",
    tags: ["json", "diff", "compare"],
    discovery: {
      bodyType: "json",
      input: { a: { x: 1, y: 2 }, b: { x: 1, y: 3, z: 4 } },
      inputSchema: {
        properties: { a: { description: "First JSON value" }, b: { description: "Second JSON value" } },
        required: ["a", "b"],
      },
      output: { example: { equal: false, differences: [{ path: "y", type: "changed", a: 2, b: 3 }, { path: "z", type: "added", b: 4 }] } },
    },
    handler: (input) => {
      if (!("a" in input) || !("b" in input)) throw bad('Provide "a" and "b"');
      const a = parseMaybeJson(input.a, "a");
      const b = parseMaybeJson(input.b, "b");
      const differences = deepDiff(a, b);
      return { equal: differences.length === 0, differences };
    },
  },
  {
    route: "POST /api/json-query",
    name: "JSON query",
    slug: "json-query",
    category: "conversion",
    price: "$0.001",
    description: 'Extract a value from JSON by dot/bracket path, e.g. "items[2].name".',
    tags: ["json", "query", "jsonpath", "extract"],
    discovery: {
      bodyType: "json",
      input: { json: { items: [{ name: "a" }, { name: "b" }] }, path: "items[1].name" },
      inputSchema: {
        properties: {
          json: { description: "JSON value (or a JSON string of one)" },
          path: { type: "string", description: 'Path like "a.b[0].c"' },
        },
        required: ["json", "path"],
      },
      output: { example: { found: true, value: "b" } },
    },
    handler: (input) => {
      const data = parseMaybeJson(need(input, "json", "any"), "json");
      const path = need(input, "path");
      const segs = path.match(/[^.[\]]+/g) ?? [];
      let cur = data;
      for (const seg of segs) {
        if (cur === null || typeof cur !== "object") return { found: false, value: null };
        cur = cur[/^\d+$/.test(seg) ? Number(seg) : seg];
        if (cur === undefined) return { found: false, value: null };
      }
      return { found: true, value: cur };
    },
  },
];

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves".split(
    " "
  )
);

function splitWords(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function lineDiff(aText, bText) {
  const a = aText.split("\n").slice(0, 2000);
  const b = bText.split("\n").slice(0, 2000);
  const m = a.length;
  const n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: "-", line: a[i++] });
    else ops.push({ op: "+", line: b[j++] });
  }
  while (i < m) ops.push({ op: "-", line: a[i++] });
  while (j < n) ops.push({ op: "+", line: b[j++] });
  return ops;
}

const LOREM_WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(
    " "
  );

const textTools = [
  {
    route: "POST /api/slugify",
    name: "Slugify",
    slug: "slugify",
    category: "text",
    price: "$0.001",
    description: "Turn any text into a URL-safe slug (lowercase, hyphenated, diacritics stripped).",
    tags: ["slug", "url", "text"],
    discovery: {
      bodyType: "json",
      input: { text: "Héllo, Wörld! 2024" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to slugify" },
          separator: { type: "string", description: "Default -" },
        },
        required: ["text"],
      },
      output: { example: { slug: "hello-world-2024" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"), 10_000);
      const sep = typeof input.separator === "string" && input.separator.length === 1 ? input.separator : "-";
      const slug = text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, sep)
        .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "");
      return { slug };
    },
  },
  {
    route: "POST /api/case",
    name: "Case convert",
    slug: "case",
    category: "text",
    price: "$0.001",
    description: "Convert text between camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE, Title Case, lower, UPPER.",
    tags: ["case", "camel", "snake", "kebab", "text"],
    discovery: {
      bodyType: "json",
      input: { text: "hello world example", to: "camel" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Input text" },
          to: { type: "string", description: "camel | pascal | snake | kebab | constant | title | lower | upper" },
        },
        required: ["text", "to"],
      },
      output: { example: { result: "helloWorldExample" } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"), 50_000);
      const to = need(input, "to").toLowerCase();
      const words = splitWords(text).map((w) => w.toLowerCase());
      const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1);
      const map = {
        camel: () => words.map((w, i) => (i ? capitalize(w) : w)).join(""),
        pascal: () => words.map(capitalize).join(""),
        snake: () => words.join("_"),
        kebab: () => words.join("-"),
        constant: () => words.join("_").toUpperCase(),
        title: () => words.map(capitalize).join(" "),
        lower: () => text.toLowerCase(),
        upper: () => text.toUpperCase(),
      };
      if (!map[to]) throw bad(`"to" must be one of: ${Object.keys(map).join(", ")}`);
      return { result: map[to]() };
    },
  },
  {
    route: "POST /api/text-stats",
    name: "Text statistics",
    slug: "text-stats",
    category: "text",
    price: "$0.001",
    description: "Characters, words, sentences, paragraphs, average word length, reading time, and an LLM token estimate for any text.",
    tags: ["text", "statistics", "tokens", "reading-time"],
    discovery: {
      bodyType: "json",
      input: { text: "Some long document…" },
      inputSchema: {
        properties: { text: { type: "string", description: "Text to analyze (max 500KB)" } },
        required: ["text"],
      },
      output: { example: { characters: 1200, words: 210, sentences: 14, paragraphs: 4, readingTimeMinutes: 1.1, estimatedTokens: 300 } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"), 500_000);
      const words = text.split(/\s+/).filter(Boolean);
      const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length || (words.length ? 1 : 0);
      const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
      return {
        characters: text.length,
        words: words.length,
        sentences,
        paragraphs,
        avgWordLength: words.length ? +(words.join("").length / words.length).toFixed(2) : 0,
        readingTimeMinutes: +(words.length / 200).toFixed(1),
        estimatedTokens: Math.round(text.length / 4),
      };
    },
  },
  {
    route: "POST /api/keywords",
    name: "Keyword extraction",
    slug: "keywords",
    category: "text",
    price: "$0.002",
    description: "Top keywords and two-word phrases by frequency (stopwords removed). Cheap, deterministic signal for routing, tagging, and dedup.",
    tags: ["keywords", "nlp", "text", "tagging"],
    discovery: {
      bodyType: "json",
      input: { text: "Long article text…", limit: 10 },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to analyze (max 500KB)" },
          limit: { type: "number", description: "Max keywords (default 15)" },
        },
        required: ["text"],
      },
      output: { example: { keywords: [{ term: "payment", count: 9 }], phrases: [{ term: "x402 protocol", count: 4 }] } },
    },
    handler: (input) => {
      const text = capText(need(input, "text"), 500_000);
      const limit = Math.min(Math.max(parseInt(input.limit, 10) || 15, 1), 50);
      const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
      const counts = new Map();
      const pairCounts = new Map();
      let prev = null;
      for (const w of words) {
        const stop = STOPWORDS.has(w);
        if (!stop) counts.set(w, (counts.get(w) || 0) + 1);
        if (prev && !stop && !STOPWORDS.has(prev)) {
          const pair = `${prev} ${w}`;
          pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
        }
        prev = stop ? null : w;
      }
      const top = (m, n) =>
        [...m.entries()]
          .filter(([, c]) => c > 1)
          .sort((x, y) => y[1] - x[1])
          .slice(0, n)
          .map(([term, count]) => ({ term, count }));
      return { keywords: top(counts, limit), phrases: top(pairCounts, Math.min(limit, 10)) };
    },
  },
  {
    route: "POST /api/text-diff",
    name: "Text diff",
    slug: "text-diff",
    category: "text",
    price: "$0.002",
    description: "Line-by-line diff of two texts (LCS). Returns unified-style ops and change counts. Up to 2000 lines per side.",
    tags: ["diff", "compare", "text"],
    discovery: {
      bodyType: "json",
      input: { a: "line1\nline2", b: "line1\nline2 changed" },
      inputSchema: {
        properties: {
          a: { type: "string", description: "Original text" },
          b: { type: "string", description: "New text" },
        },
        required: ["a", "b"],
      },
      output: { example: { added: 1, removed: 1, unchanged: 1, diff: [{ op: " ", line: "line1" }, { op: "-", line: "line2" }, { op: "+", line: "line2 changed" }] } },
    },
    handler: (input) => {
      const a = capText(need(input, "a"), 200_000, "a");
      const b = capText(need(input, "b"), 200_000, "b");
      const diff = lineDiff(a, b);
      return {
        added: diff.filter((d) => d.op === "+").length,
        removed: diff.filter((d) => d.op === "-").length,
        unchanged: diff.filter((d) => d.op === " ").length,
        diff,
      };
    },
  },
  {
    route: "POST /api/regex",
    name: "Regex test",
    slug: "regex",
    category: "text",
    price: "$0.001",
    description: "Run a regular expression against text. Returns up to 100 matches with index and capture groups. Pattern ≤ 200 chars, text ≤ 10KB.",
    tags: ["regex", "match", "text", "pattern"],
    discovery: {
      bodyType: "json",
      input: { pattern: "\\b(\\w+)@(\\w+\\.\\w+)\\b", flags: "g", text: "mail me at a@b.com" },
      inputSchema: {
        properties: {
          pattern: { type: "string", description: "Regex pattern (JS syntax, max 200 chars)" },
          flags: { type: "string", description: "Regex flags, e.g. gi (default g)" },
          text: { type: "string", description: "Text to search (max 10KB)" },
        },
        required: ["pattern", "text"],
      },
      output: { example: { matchCount: 1, matches: [{ match: "a@b.com", index: 11, groups: ["a", "b.com"] }] } },
    },
    handler: (input) => {
      const pattern = capText(need(input, "pattern"), 200, "pattern");
      const text = capText(need(input, "text"), 10_000);
      const flags = typeof input.flags === "string" && /^[gimsuy]*$/.test(input.flags) ? input.flags : "g";
      let re;
      try {
        re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
      } catch (e) {
        throw bad(`Invalid regex: ${e.message}`);
      }
      const matches = [];
      let m;
      while ((m = re.exec(text)) && matches.length < 100) {
        matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return { matchCount: matches.length, matches };
    },
  },
  {
    route: "GET /api/lorem",
    name: "Lorem ipsum",
    slug: "lorem",
    category: "text",
    price: "$0.001",
    description: "Placeholder text. ?paragraphs=1..20 or ?words=1..2000.",
    tags: ["lorem", "placeholder", "generator", "text"],
    discovery: {
      input: { paragraphs: "2" },
      inputSchema: {
        properties: {
          paragraphs: { type: "string", description: "1-20 (default 1)" },
          words: { type: "string", description: "Alternative: exact word count (1-2000)" },
        },
      },
      output: { example: { text: "Lorem ipsum dolor sit amet…" } },
    },
    handler: (input) => {
      const pick = (i) => LOREM_WORDS[(i * 7 + randomInt(5)) % LOREM_WORDS.length];
      if (input.words !== undefined) {
        const n = Math.min(Math.max(parseInt(input.words, 10) || 50, 1), 2000);
        const ws = Array.from({ length: n }, (_, i) => pick(i));
        ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
        return { text: ws.join(" ") + "." };
      }
      const paras = Math.min(Math.max(parseInt(input.paragraphs, 10) || 1, 1), 20);
      const out = [];
      for (let p = 0; p < paras; p++) {
        const n = 40 + randomInt(40);
        const ws = Array.from({ length: n }, (_, i) => pick(i + p * 13));
        ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
        out.push(ws.join(" ") + ".");
      }
      return { text: out.join("\n\n") };
    },
  },
];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function formatInTz(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      dateStyle: "short",
      timeStyle: "long",
      hourCycle: "h23",
    }).format(date);
  } catch {
    throw bad(`Unknown timezone: ${tz}`);
  }
}

function parseWhen(value) {
  if (value === undefined || value === null || value === "now") return new Date();
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return new Date(n < 1e12 ? n * 1000 : n); // seconds vs ms
  }
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw bad(`Cannot parse date/time: ${value}`);
  return d;
}

function parseCronField(field, min, max) {
  const set = new Set();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw bad(`Invalid cron field: ${part}`);
    const step = m[2] ? parseInt(m[2], 10) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const range = m[1].split("-").map(Number);
      lo = range[0];
      hi = range.length > 1 ? range[1] : step > 1 ? max : range[0];
    }
    if (lo < min || hi > max || lo > hi) throw bad(`Cron value out of range: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

const timeTools = [
  {
    route: "GET /api/time",
    name: "Current time",
    slug: "time",
    category: "time",
    price: "$0.001",
    description: "Current time: UTC ISO, epoch seconds/ms, day of week/year, ISO week — optionally rendered in any IANA timezone via ?tz=.",
    tags: ["time", "clock", "timezone", "utc"],
    discovery: {
      input: { tz: "America/New_York" },
      inputSchema: { properties: { tz: { type: "string", description: "IANA timezone (optional)" } } },
      output: { example: { utc: "2026-06-11T10:00:00.000Z", epochSeconds: 1781172000, dayOfWeek: "Thursday", local: "2026-06-11 06:00:00 EDT" } },
    },
    handler: (input) => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const dayOfYear = Math.floor((now - start) / 86_400_000) + 1;
      const out = {
        utc: now.toISOString(),
        epochSeconds: Math.floor(now.getTime() / 1000),
        epochMillis: now.getTime(),
        dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        dayOfYear,
      };
      if (input.tz) {
        out.timezone = input.tz;
        out.local = formatInTz(now, input.tz);
      }
      return out;
    },
  },
  {
    route: "POST /api/time-convert",
    name: "Time convert",
    slug: "time-convert",
    category: "time",
    price: "$0.001",
    description: "Convert between epoch (s or ms), ISO 8601, and any IANA timezone. Give a value, get every representation back.",
    tags: ["time", "epoch", "timezone", "convert", "iso8601"],
    discovery: {
      bodyType: "json",
      input: { value: 1781172000, tz: "Asia/Tokyo" },
      inputSchema: {
        properties: {
          value: { description: "Epoch seconds/ms, ISO string, or 'now'" },
          tz: { type: "string", description: "IANA timezone to render in (optional)" },
        },
        required: ["value"],
      },
      output: { example: { utc: "2026-06-11T10:00:00.000Z", epochSeconds: 1781172000, epochMillis: 1781172000000, local: "2026-06-11 19:00:00 JST" } },
    },
    handler: (input) => {
      const d = parseWhen(input.value);
      const out = { utc: d.toISOString(), epochSeconds: Math.floor(d.getTime() / 1000), epochMillis: d.getTime() };
      if (input.tz) {
        out.timezone = input.tz;
        out.local = formatInTz(d, input.tz);
      }
      return out;
    },
  },
  {
    route: "POST /api/cron-next",
    name: "Cron next runs",
    slug: "cron-next",
    category: "time",
    price: "$0.002",
    description: "Parse a 5-field cron expression and return the next N run times (UTC).",
    tags: ["cron", "schedule", "time"],
    discovery: {
      bodyType: "json",
      input: { expr: "*/15 9-17 * * 1-5", count: 5 },
      inputSchema: {
        properties: {
          expr: { type: "string", description: "5-field cron: minute hour day-of-month month day-of-week" },
          count: { type: "number", description: "How many upcoming runs (1-20, default 5)" },
          from: { description: "Start time (epoch/ISO, default now)" },
        },
        required: ["expr"],
      },
      output: { example: { expr: "*/15 9-17 * * 1-5", next: ["2026-06-11T09:00:00.000Z"] } },
    },
    handler: (input) => {
      const expr = need(input, "expr").trim();
      const fields = expr.split(/\s+/);
      if (fields.length !== 5) throw bad("Cron expression must have 5 fields");
      const [minS, hourS, domS, monS, dowS] = fields;
      const minutes = parseCronField(minS, 0, 59);
      const hours = parseCronField(hourS, 0, 23);
      const doms = parseCronField(domS, 1, 31);
      const months = parseCronField(monS, 1, 12);
      const dows = parseCronField(dowS.replace(/7/g, "0"), 0, 6);
      const count = Math.min(Math.max(parseInt(input.count, 10) || 5, 1), 20);
      const domRestricted = domS !== "*";
      const dowRestricted = dowS !== "*";
      const next = [];
      const cursor = parseWhen(input.from);
      cursor.setUTCSeconds(0, 0);
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      for (let i = 0; i < 366 * 24 * 60 && next.length < count; i++) {
        const okDay =
          domRestricted && dowRestricted
            ? doms.has(cursor.getUTCDate()) || dows.has(cursor.getUTCDay())
            : doms.has(cursor.getUTCDate()) && dows.has(cursor.getUTCDay());
        if (
          minutes.has(cursor.getUTCMinutes()) &&
          hours.has(cursor.getUTCHours()) &&
          months.has(cursor.getUTCMonth() + 1) &&
          okDay
        )
          next.push(cursor.toISOString());
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      }
      return { expr, next };
    },
  },
  {
    route: "POST /api/duration",
    name: "Duration parse/humanize",
    slug: "duration",
    category: "time",
    price: "$0.001",
    description: 'Parse a duration like "2h30m" / "1d4h" / "90s" to seconds, or humanize a number of seconds.',
    tags: ["duration", "time", "parse", "humanize"],
    discovery: {
      bodyType: "json",
      input: { value: "2h30m" },
      inputSchema: {
        properties: { value: { description: 'Duration string ("1d2h3m4s") or number of seconds' } },
        required: ["value"],
      },
      output: { example: { seconds: 9000, human: "2h 30m", iso8601: "PT2H30M" } },
    },
    handler: (input) => {
      let seconds;
      const v = input.value;
      if (typeof v === "number") seconds = v;
      else if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) seconds = Number(v);
      else if (typeof v === "string") {
        const matches = [...v.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m|s|ms)/g)];
        if (!matches.length) throw bad(`Cannot parse duration: ${v}`);
        const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
        seconds = matches.reduce((acc, m) => acc + Number(m[1]) * mult[m[2]], 0);
      } else throw bad('Provide "value" as a duration string or seconds');
      const units = [
        ["d", 86400],
        ["h", 3600],
        ["m", 60],
        ["s", 1],
      ];
      let rest = Math.round(seconds);
      const human = [];
      const isoParts = { d: 0, h: 0, m: 0, s: 0 };
      for (const [u, mul] of units) {
        const q = Math.floor(rest / mul);
        if (q) {
          human.push(`${q}${u}`);
          isoParts[u] = q;
        }
        rest %= mul;
      }
      const iso =
        "P" + (isoParts.d ? `${isoParts.d}D` : "") + ("T" + (isoParts.h ? `${isoParts.h}H` : "") + (isoParts.m ? `${isoParts.m}M` : "") + (isoParts.s ? `${isoParts.s}S` : "")).replace(/^T$/, "T0S");
      return { seconds, human: human.join(" ") || "0s", iso8601: iso };
    },
  },
  {
    route: "POST /api/date-diff",
    name: "Date difference",
    slug: "date-diff",
    category: "time",
    price: "$0.001",
    description: "Difference between two dates/times in ms, seconds, minutes, hours, days, and a human summary.",
    tags: ["date", "diff", "time", "compare"],
    discovery: {
      bodyType: "json",
      input: { from: "2026-01-01", to: "2026-06-11T10:00:00Z" },
      inputSchema: {
        properties: {
          from: { description: "Start (epoch/ISO)" },
          to: { description: "End (epoch/ISO, default now)" },
        },
        required: ["from"],
      },
      output: { example: { millis: 13948800000, days: 161.4, human: "161d 10h" } },
    },
    handler: (input) => {
      const from = parseWhen(need(input, "from", "any"));
      const to = parseWhen(input.to);
      const ms = to.getTime() - from.getTime();
      const abs = Math.abs(ms);
      const days = Math.floor(abs / 86_400_000);
      const hours = Math.floor((abs % 86_400_000) / 3_600_000);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        millis: ms,
        seconds: +(ms / 1000).toFixed(1),
        minutes: +(ms / 60_000).toFixed(2),
        hours: +(ms / 3_600_000).toFixed(2),
        days: +(ms / 86_400_000).toFixed(2),
        human: `${ms < 0 ? "-" : ""}${days}d ${hours}h`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Validation & parsing
// ---------------------------------------------------------------------------

const MIME_MAP = {
  txt: "text/plain", html: "text/html", css: "text/css", csv: "text/csv", md: "text/markdown",
  js: "text/javascript", mjs: "text/javascript", json: "application/json", xml: "application/xml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif", bmp: "image/bmp", tiff: "image/tiff",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wasm: "application/wasm", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
  webmanifest: "application/manifest+json", epub: "application/epub+zip", rtf: "application/rtf",
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw bad(`Invalid hex color: ${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHsl(r, g, b) {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function parseSemver(v) {
  const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) throw bad(`Not a valid semver: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null, build: m[5] ?? null };
}

function compareSemver(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

const validationTools = [
  {
    route: "POST /api/email-validate",
    name: "Email validate",
    slug: "email-validate",
    category: "validation",
    price: "$0.002",
    description: "Validate an email address: syntax check plus live MX record lookup on the domain (deliverability signal, not a guarantee).",
    tags: ["email", "validate", "mx", "deliverability"],
    discovery: {
      bodyType: "json",
      input: { email: "ada@example.com" },
      inputSchema: {
        properties: { email: { type: "string", description: "Email address to check" } },
        required: ["email"],
      },
      output: { example: { email: "ada@example.com", syntaxValid: true, domain: "example.com", mxRecords: ["mail.example.com"], deliverableDomain: true } },
    },
    handler: async (input) => {
      const email = need(input, "email").trim();
      const syntaxValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
      const domain = syntaxValid ? email.split("@")[1].toLowerCase() : null;
      let mxRecords = [];
      if (domain) {
        try {
          mxRecords = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
        } catch {
          mxRecords = [];
        }
      }
      return { email, syntaxValid, domain, mxRecords: mxRecords.slice(0, 10), deliverableDomain: mxRecords.length > 0 };
    },
  },
  {
    route: "POST /api/url-parse",
    name: "URL parse",
    slug: "url-parse",
    category: "validation",
    price: "$0.001",
    description: "Parse a URL into components: protocol, host, port, path, query params (decoded), hash, origin, punycode hostname.",
    tags: ["url", "parse", "query-string"],
    discovery: {
      bodyType: "json",
      input: { url: "https://ex.com:8080/a/b?x=1&y=hello%20world#frag" },
      inputSchema: {
        properties: { url: { type: "string", description: "URL to parse" } },
        required: ["url"],
      },
      output: { example: { protocol: "https:", hostname: "ex.com", port: "8080", pathname: "/a/b", query: { x: "1", y: "hello world" }, hash: "#frag" } },
    },
    handler: (input) => {
      let u;
      try {
        u = new URL(need(input, "url"));
      } catch {
        throw bad("Invalid URL");
      }
      return {
        href: u.href,
        protocol: u.protocol,
        username: u.username,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        query: Object.fromEntries(u.searchParams.entries()),
        hash: u.hash,
        origin: u.origin,
      };
    },
  },
  {
    route: "POST /api/ip-info",
    name: "IP info",
    slug: "ip-info",
    category: "validation",
    price: "$0.002",
    description: "Classify an IP address: version, public/private/loopback/link-local, integer form, and reverse-DNS (PTR) lookup.",
    tags: ["ip", "network", "ptr", "reverse-dns"],
    discovery: {
      bodyType: "json",
      input: { ip: "8.8.8.8" },
      inputSchema: {
        properties: { ip: { type: "string", description: "IPv4 or IPv6 address" } },
        required: ["ip"],
      },
      output: { example: { ip: "8.8.8.8", version: 4, scope: "public", ptr: ["dns.google"] } },
    },
    handler: async (input) => {
      const ip = need(input, "ip").trim();
      const version = isIP(ip);
      if (!version) throw bad("Not a valid IP address");
      let scope = "public";
      if (version === 4) {
        const [a, b] = ip.split(".").map(Number);
        if (a === 127) scope = "loopback";
        else if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) scope = "private";
        else if (a === 169 && b === 254) scope = "link-local";
        else if (a === 100 && b >= 64 && b <= 127) scope = "cgnat";
      } else {
        const lower = ip.toLowerCase();
        if (lower === "::1") scope = "loopback";
        else if (lower.startsWith("fe80")) scope = "link-local";
        else if (lower.startsWith("fc") || lower.startsWith("fd")) scope = "private";
      }
      let ptr = [];
      if (scope === "public") {
        try {
          ptr = await reverse(ip);
        } catch {
          ptr = [];
        }
      }
      const out = { ip, version, scope, ptr: ptr.slice(0, 5) };
      if (version === 4) out.integer = ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
      return out;
    },
  },
  {
    route: "POST /api/user-agent",
    name: "User-agent parse",
    slug: "user-agent",
    category: "validation",
    price: "$0.001",
    description: "Heuristic user-agent string parser: browser, version, OS, device class, and bot detection.",
    tags: ["user-agent", "browser", "bot-detection", "parse"],
    discovery: {
      bodyType: "json",
      input: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" },
      inputSchema: {
        properties: { ua: { type: "string", description: "User-Agent header value" } },
        required: ["ua"],
      },
      output: { example: { browser: "Chrome", version: "125.0", os: "Windows", device: "desktop", bot: false } },
    },
    handler: (input) => {
      const ua = capText(need(input, "ua"), 2000, "ua");
      const bot = /bot|crawler|spider|scraper|curl|wget|python-requests|httpclient|gptbot|claudebot|googlebot|bingbot/i.test(ua);
      const tests = [
        ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
        ["Opera", /OPR\/([\d.]+)/],
        ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
        ["Chrome", /Chrome\/([\d.]+)/],
        ["Firefox", /Firefox\/([\d.]+)/],
        ["Safari", /Version\/([\d.]+).*Safari/],
      ];
      let browser = null;
      let version = null;
      for (const [name, re] of tests) {
        const m = ua.match(re);
        if (m) {
          browser = name;
          version = m[1];
          break;
        }
      }
      const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
      const device = /Mobile|iPhone|Android.*Mobile/.test(ua) ? "mobile" : /iPad|Tablet/.test(ua) ? "tablet" : "desktop";
      return { browser, version, os, device, bot };
    },
  },
  {
    route: "POST /api/color",
    name: "Color convert",
    slug: "color",
    category: "validation",
    price: "$0.001",
    description: 'Convert a color between hex, RGB, and HSL. Accepts "#1a2b3c", "rgb(26,43,60)", or "hsl(210,40%,17%)".',
    tags: ["color", "hex", "rgb", "hsl", "convert"],
    discovery: {
      bodyType: "json",
      input: { color: "#4ade80" },
      inputSchema: {
        properties: { color: { type: "string", description: "Color in hex, rgb(), or hsl() form" } },
        required: ["color"],
      },
      output: { example: { hex: "#4ade80", rgb: [74, 222, 128], hsl: [142, 69, 58], luminance: 0.58 } },
    },
    handler: (input) => {
      const c = need(input, "color").trim();
      let rgb;
      const rgbM = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      const hslM = c.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/i);
      if (rgbM) rgb = rgbM.slice(1, 4).map(Number);
      else if (hslM) {
        const [h, s, l] = hslM.slice(1, 4).map(Number);
        const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
        const f = (n) => {
          const k = (n + h / 30) % 12;
          return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        rgb = [f(0), f(8), f(4)];
      } else rgb = hexToRgb(c);
      if (rgb.some((v) => v < 0 || v > 255)) throw bad("Color channel out of range");
      const hex = "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
      const [lr, lg, lb] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return { hex, rgb, hsl: rgbToHsl(...rgb), luminance: +(0.2126 * lr + 0.7152 * lg + 0.0722 * lb).toFixed(3) };
    },
  },
  {
    route: "POST /api/semver",
    name: "Semver parse/compare",
    slug: "semver",
    category: "validation",
    price: "$0.001",
    description: "Parse a semantic version, or compare two (a vs b → -1/0/1, with greater/lesser flags).",
    tags: ["semver", "version", "compare"],
    discovery: {
      bodyType: "json",
      input: { a: "2.4.0", b: "2.10.1" },
      inputSchema: {
        properties: {
          a: { type: "string", description: "Version to parse (or left side of compare)" },
          b: { type: "string", description: "Optional right side of compare" },
        },
        required: ["a"],
      },
      output: { example: { a: { major: 2, minor: 4, patch: 0 }, comparison: -1, aGreater: false, equal: false } },
    },
    handler: (input) => {
      const a = parseSemver(need(input, "a"));
      if (input.b === undefined) return { a };
      const b = parseSemver(input.b);
      const cmp = compareSemver(a, b);
      return { a, b, comparison: cmp, aGreater: cmp > 0, equal: cmp === 0 };
    },
  },
  {
    route: "GET /api/mime",
    name: "MIME lookup",
    slug: "mime",
    category: "validation",
    price: "$0.001",
    description: "Look up a MIME type by file extension (?ext=png) or extensions by MIME type (?type=image/png). Covers ~50 common types.",
    tags: ["mime", "content-type", "file-extension"],
    discovery: {
      input: { ext: "webp" },
      inputSchema: {
        properties: {
          ext: { type: "string", description: "File extension (with or without dot)" },
          type: { type: "string", description: "MIME type to reverse-lookup" },
        },
      },
      output: { example: { ext: "webp", mime: "image/webp" } },
    },
    handler: (input) => {
      if (input.ext) {
        const ext = String(input.ext).toLowerCase().replace(/^\./, "");
        const mime = MIME_MAP[ext];
        if (!mime) throw bad(`Unknown extension: ${ext}`);
        return { ext, mime };
      }
      if (input.type) {
        const type = String(input.type).toLowerCase();
        const exts = Object.entries(MIME_MAP).filter(([, m]) => m === type).map(([e]) => e);
        if (!exts.length) throw bad(`Unknown MIME type: ${type}`);
        return { type, extensions: exts };
      }
      throw bad("Provide ?ext= or ?type=");
    },
  },
  {
    route: "POST /api/iban-validate",
    name: "IBAN validate",
    slug: "iban-validate",
    category: "validation",
    price: "$0.001",
    description: "Validate an IBAN: country code, length, and the ISO 13616 mod-97 checksum.",
    tags: ["iban", "banking", "validate", "finance"],
    discovery: {
      bodyType: "json",
      input: { iban: "DE89370400440532013000" },
      inputSchema: {
        properties: { iban: { type: "string", description: "IBAN (spaces allowed)" } },
        required: ["iban"],
      },
      output: { example: { valid: true, country: "DE", formatted: "DE89 3704 0044 0532 0130 00" } },
    },
    handler: (input) => {
      const raw = need(input, "iban").replace(/\s+/g, "").toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(raw)) return { valid: false, reason: "Bad format or length" };
      const rearranged = raw.slice(4) + raw.slice(0, 4);
      const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
      let rem = 0;
      for (const ch of numeric) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
      const valid = rem === 1;
      return {
        valid,
        country: raw.slice(0, 2),
        formatted: raw.replace(/(.{4})/g, "$1 ").trim(),
        ...(valid ? {} : { reason: "Checksum failed" }),
      };
    },
  },
  {
    route: "POST /api/card-validate",
    name: "Card number validate",
    slug: "card-validate",
    category: "validation",
    price: "$0.001",
    description: "Validate a payment card number (Luhn checksum) and detect the brand. Numbers are not stored or logged.",
    tags: ["luhn", "credit-card", "validate", "finance"],
    discovery: {
      bodyType: "json",
      input: { number: "4242 4242 4242 4242" },
      inputSchema: {
        properties: { number: { type: "string", description: "Card number (spaces/dashes allowed)" } },
        required: ["number"],
      },
      output: { example: { valid: true, brand: "visa", length: 16 } },
    },
    handler: (input) => {
      const digits = need(input, "number").replace(/[\s-]+/g, "");
      if (!/^\d{12,19}$/.test(digits)) return { valid: false, reason: "Must be 12-19 digits" };
      const valid = luhnValid(digits);
      const brand = /^4/.test(digits)
        ? "visa"
        : /^(5[1-5]|2[2-7])/.test(digits)
          ? "mastercard"
          : /^3[47]/.test(digits)
            ? "amex"
            : /^(6011|65|64[4-9])/.test(digits)
              ? "discover"
              : /^35/.test(digits)
                ? "jcb"
                : /^3[068]/.test(digits)
                  ? "diners"
                  : "unknown";
      return { valid, brand, length: digits.length };
    },
  },
];

// ---------------------------------------------------------------------------
// Network & web
// ---------------------------------------------------------------------------

async function assertPublicHost(host) {
  if (isIP(host)) {
    // reuse the URL guard by faking a URL
    await assertPublicUrl(`https://${host}/`);
    return;
  }
  let resolved;
  try {
    resolved = await lookup(host);
  } catch {
    throw bad(`Could not resolve host: ${host}`);
  }
  await assertPublicUrl(`https://${resolved.address.includes(":") ? `[${resolved.address}]` : resolved.address}/`).catch(() => {
    throw bad("Host resolves to a private address");
  });
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split("\n").slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

function robotsAllows(groups, ua, path) {
  const uaLower = ua.toLowerCase();
  let group =
    groups.find((g) => g.agents.some((a) => a !== "*" && uaLower.includes(a))) ??
    groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matchedRule: null };
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    const pattern = rule.path.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp("^" + pattern.replace(/\\\$$/, "$"));
    if (re.test(path) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  return { allowed: best ? best.allow : true, matchedRule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null };
}

const networkTools = [
  {
    route: "POST /api/http-check",
    name: "HTTP check",
    slug: "http-check",
    category: "network",
    price: "$0.003",
    description: "Check any public URL: status code, latency, final URL after redirects, and response headers. The uptime primitive for agent monitors.",
    tags: ["uptime", "monitoring", "http", "headers", "latency"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public http(s) URL" },
          method: { type: "string", description: "GET (default) or HEAD" },
        },
        required: ["url"],
      },
      output: { example: { up: true, status: 200, latencyMs: 87, finalUrl: "https://example.com/", headers: { "content-type": "text/html" } } },
    },
    handler: async (input) => {
      const url = await assertPublicUrl(need(input, "url"));
      const method = String(input.method || "GET").toUpperCase() === "HEAD" ? "HEAD" : "GET";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method,
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)" },
        });
        const latencyMs = Date.now() - started;
        res.body?.cancel?.();
        const headers = {};
        for (const k of ["content-type", "content-length", "server", "cache-control", "last-modified", "etag", "location", "x-powered-by"]) {
          const v = res.headers.get(k);
          if (v) headers[k] = v;
        }
        return { up: res.status < 500, status: res.status, latencyMs, finalUrl: res.url, headers };
      } catch (err) {
        return { up: false, error: err.name === "AbortError" ? "Timed out after 15s" : err.message, latencyMs: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    route: "POST /api/tls-cert",
    name: "TLS certificate",
    slug: "tls-cert",
    category: "network",
    price: "$0.003",
    description: "Inspect the TLS certificate of any public host: subject, issuer, validity window, days remaining, SANs, and SHA-256 fingerprint.",
    tags: ["tls", "ssl", "certificate", "expiry", "security"],
    discovery: {
      bodyType: "json",
      input: { host: "example.com" },
      inputSchema: {
        properties: { host: { type: "string", description: "Hostname (port 443)" } },
        required: ["host"],
      },
      output: { example: { host: "example.com", issuer: "DigiCert", validTo: "2027-01-01T00:00:00.000Z", daysRemaining: 204, altNames: ["example.com"] } },
    },
    handler: async (input) => {
      const host = need(input, "host").trim().toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host)) throw bad("Invalid hostname");
      await assertPublicHost(host);
      const cert = await new Promise((resolve, reject) => {
        const socket = tls.connect(
          { host, port: 443, servername: host, timeout: 10_000, rejectUnauthorized: false },
          () => {
            const c = socket.getPeerCertificate();
            const authorized = socket.authorized;
            socket.end();
            resolve({ c, authorized });
          }
        );
        socket.on("timeout", () => {
          socket.destroy();
          reject(Object.assign(new Error("TLS connection timed out"), { statusCode: 504 }));
        });
        socket.on("error", (e) => reject(Object.assign(new Error(`TLS error: ${e.message}`), { statusCode: 502 })));
      });
      const { c, authorized } = cert;
      if (!c || !c.valid_to) throw Object.assign(new Error("No certificate presented"), { statusCode: 502 });
      const validTo = new Date(c.valid_to);
      return {
        host,
        subject: c.subject?.CN ?? null,
        issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
        validFrom: new Date(c.valid_from).toISOString(),
        validTo: validTo.toISOString(),
        daysRemaining: Math.floor((validTo - Date.now()) / 86_400_000),
        altNames: (c.subjectaltname || "").split(", ").map((s) => s.replace(/^DNS:/, "")).filter(Boolean).slice(0, 50),
        chainTrusted: authorized,
        fingerprint256: c.fingerprint256 ?? null,
      };
    },
  },
  {
    route: "POST /api/whois",
    name: "Domain WHOIS (RDAP)",
    slug: "whois",
    category: "network",
    price: "$0.003",
    description: "Domain registration data via RDAP (the structured WHOIS successor): registrar, creation/expiry dates, status, nameservers.",
    tags: ["whois", "rdap", "domain", "registration"],
    discovery: {
      bodyType: "json",
      input: { domain: "example.com" },
      inputSchema: {
        properties: { domain: { type: "string", description: "Domain name (registrable, e.g. example.com)" } },
        required: ["domain"],
      },
      output: { example: { domain: "example.com", registrar: "IANA", created: "1995-08-14", expires: "2026-08-13", nameservers: ["a.iana-servers.net"], status: ["client transfer prohibited"] } },
    },
    handler: async (input) => {
      const domain = need(input, "domain").trim().toLowerCase().replace(/\.$/, "");
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw bad("Invalid domain");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let data;
      try {
        const res = await fetch(`https://rdap.org/domain/${domain}`, {
          signal: controller.signal,
          redirect: "follow",
          headers: { Accept: "application/rdap+json" },
        });
        if (res.status === 404) throw Object.assign(new Error("Domain not found in RDAP"), { statusCode: 404 });
        if (!res.ok) throw Object.assign(new Error(`RDAP returned HTTP ${res.status}`), { statusCode: 502 });
        data = await res.json();
      } catch (err) {
        if (err.statusCode) throw err;
        throw Object.assign(new Error(err.name === "AbortError" ? "RDAP lookup timed out" : `RDAP lookup failed: ${err.message}`), { statusCode: 502 });
      } finally {
        clearTimeout(timer);
      }
      const event = (name) => data.events?.find((e) => e.eventAction === name)?.eventDate ?? null;
      const registrar = data.entities?.find((e) => e.roles?.includes("registrar"));
      const registrarName = registrar?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3] ?? registrar?.handle ?? null;
      return {
        domain,
        registrar: registrarName,
        created: event("registration"),
        updated: event("last changed"),
        expires: event("expiration"),
        status: data.status ?? [],
        nameservers: (data.nameservers ?? []).map((n) => n.ldhName?.toLowerCase()).filter(Boolean),
        dnssec: data.secureDNS?.delegationSigned ?? null,
      };
    },
  },
  {
    route: "POST /api/robots-check",
    name: "Robots.txt check",
    slug: "robots-check",
    category: "network",
    price: "$0.002",
    description: "Fetch a site's robots.txt and answer: may this user-agent crawl this path? Returns the matched rule and all declared sitemaps.",
    tags: ["robots", "crawling", "scraping", "compliance"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/some/page", userAgent: "MyAgent" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL whose path to check" },
          userAgent: { type: "string", description: "User-agent token (default *)" },
        },
        required: ["url"],
      },
      output: { example: { allowed: true, matchedRule: null, sitemaps: ["https://example.com/sitemap.xml"] } },
    },
    handler: async (input) => {
      const target = await assertPublicUrl(need(input, "url"));
      const ua = typeof input.userAgent === "string" && input.userAgent ? input.userAgent : "*";
      let text = "";
      try {
        ({ html: text } = await safeFetch(`${target.origin}/robots.txt`, { maxBytes: 512 * 1024 }));
      } catch {
        return { allowed: true, matchedRule: null, note: "No readable robots.txt — crawling is not restricted by robots.txt", sitemaps: [] };
      }
      const groups = parseRobots(text);
      const { allowed, matchedRule } = robotsAllows(groups, ua, target.pathname + target.search);
      const sitemaps = [...text.matchAll(/^sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 20);
      return { allowed, matchedRule, userAgent: ua, path: target.pathname, sitemaps };
    },
  },
  {
    route: "POST /api/sitemap",
    name: "Sitemap reader",
    slug: "sitemap",
    category: "network",
    price: "$0.003",
    description: "Fetch and parse a sitemap.xml (or sitemap index): returns up to 500 URLs with lastmod, or the child sitemaps of an index.",
    tags: ["sitemap", "crawling", "seo", "urls"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/sitemap.xml" },
      inputSchema: {
        properties: { url: { type: "string", description: "Sitemap URL (xml)" } },
        required: ["url"],
      },
      output: { example: { type: "urlset", count: 42, urls: [{ loc: "https://example.com/", lastmod: "2026-06-01" }] } },
    },
    handler: async (input) => {
      const { html: xml } = await safeFetch(need(input, "url"), { maxBytes: 5 * 1024 * 1024 });
      const isIndex = /<sitemapindex/i.test(xml);
      const blocks = [...xml.matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/gi)].slice(0, 500);
      const urls = blocks.map((b) => {
        const loc = b[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1] ?? null;
        const lastmod = b[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1] ?? undefined;
        return lastmod ? { loc, lastmod } : { loc };
      }).filter((u) => u.loc);
      return { type: isIndex ? "sitemapindex" : "urlset", count: urls.length, [isIndex ? "sitemaps" : "urls"]: urls };
    },
  },
  {
    route: "GET /api/qr",
    name: "QR code",
    slug: "qr",
    category: "identifiers",
    price: "$0.002",
    description: "Generate a QR code PNG from any text or URL. ?text=…&size=256 (128-1024).",
    tags: ["qr", "qrcode", "png", "generator"],
    mimeType: "image/png",
    discovery: {
      input: { text: "https://agent402.tools", size: "256" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Content to encode (max 2KB)" },
          size: { type: "string", description: "Image width px (128-1024, default 256)" },
        },
        required: ["text"],
      },
      output: { example: { contentType: "image/png", body: "(binary PNG image)" } },
    },
    handler: async (input) => {
      const text = capText(need(input, "text"), 2048);
      const size = Math.min(Math.max(parseInt(input.size, 10) || 256, 128), 1024);
      const buffer = await QRCode.toBuffer(text, { width: size, margin: 2 });
      return { __binary: buffer, contentType: "image/png" };
    },
  },
];

export const KIT = [...encodingTools, ...dataTools, ...textTools, ...timeTools, ...validationTools, ...networkTools];
