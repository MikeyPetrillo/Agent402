// Util-kit — deterministic gap-fillers that round out the catalog's existing
// families: jwt-sign (completes decode/verify/sign), uuid-v5 (deterministic IDs
// to pair with the random uuid/ulid), group-by (the data-wrangling aggregate
// agents reach for), json-to-xml (reverse of xml-to-json), geo-distance
// (haversine), and color-contrast (WCAG). All pure-CPU, no network, no LLM —
// proof-of-work eligible. Covered by scripts/test-util-kit.js.
import { createHmac, createHash } from "node:crypto";

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
const parseMaybeJson = (v, label) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { throw bad(`"${label}" is not valid JSON: ${e.message}`); }
};
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------------------------------------------------------------------------
const HS = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };

// uuid-v5: namespace (a UUID, or a well-known alias) + name → deterministic UUID.
const NS_ALIASES = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToUuid(b) {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// json-to-xml: minimal, correct serializer (escapes text + attribute-free).
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const safeTag = (k) => (/^[A-Za-z_][\w.-]*$/.test(k) ? k : "item");
function toXml(value, tag, indent) {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => toXml(v, tag, indent)).join("\n");
  if (typeof value === "object") {
    const inner = Object.entries(value).map(([k, v]) => toXml(v, safeTag(k), indent + 1)).join("\n");
    return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${xmlEsc(value)}</${tag}>`;
}

// color-contrast: parse #rgb / #rrggbb → relative luminance → WCAG ratio.
function hexToRgb(hex) {
  const m = String(hex).trim().replace(/^#/, "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw bad(`invalid hex color "${hex}" (use #rgb or #rrggbb)`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function relLuminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export const UTIL_TOOLS = [
  {
    route: "POST /api/jwt-sign", name: "JWT sign", slug: "jwt-sign", category: "encoding", price: "$0.001",
    description:
      "Mint a signed JSON Web Token (HMAC: HS256 default, HS384, HS512) from a payload + secret. Pairs with jwt-decode/jwt-verify to complete the trio. Deterministic — same payload, secret, and alg always produce the same token.",
    tags: ["jwt", "jws", "hmac", "token", "auth"],
    discovery: {
      bodyType: "json",
      input: { payload: { sub: "123", role: "admin" }, secret: "s3cr3t", alg: "HS256" },
      inputSchema: {
        properties: {
          payload: { type: "object", description: "claims to encode (object)" },
          secret: { type: "string", description: "HMAC signing secret" },
          alg: { type: "string", description: "HS256 (default) | HS384 | HS512" },
        },
        required: ["payload", "secret"],
      },
      output: { example: { token: "eyJhbGci...", alg: "HS256" } },
    },
    handler: (i) => {
      const payload = parseMaybeJson(i.payload, "payload");
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw bad('"payload" must be a JSON object');
      const secret = need(i, "secret");
      const alg = (i.alg || "HS256").toUpperCase();
      if (!HS[alg]) throw bad(`unsupported alg "${alg}" (HS256 | HS384 | HS512)`);
      const head = b64url(JSON.stringify({ alg, typ: "JWT" }));
      const body = b64url(JSON.stringify(payload));
      const sig = b64url(createHmac(HS[alg], secret).update(`${head}.${body}`).digest());
      return { token: `${head}.${body}.${sig}`, alg };
    },
  },
  {
    route: "POST /api/uuid-v5", name: "UUID v5 (deterministic)", slug: "uuid-v5", category: "identifiers", price: "$0.001",
    description:
      "Generate a deterministic name-based UUID (version 5, SHA-1) from a namespace + name — the same inputs always yield the same UUID, for stable IDs without a database. Namespace may be a UUID or an alias: dns | url | oid | x500.",
    tags: ["uuid", "uuidv5", "deterministic", "identifier", "rfc4122"],
    discovery: {
      bodyType: "json",
      input: { namespace: "url", name: "https://agent402.tools" },
      inputSchema: {
        properties: {
          namespace: { type: "string", description: "a UUID, or alias: dns | url | oid | x500" },
          name: { type: "string", description: "the name to hash within the namespace" },
        },
        required: ["namespace", "name"],
      },
      output: { example: { uuid: "0e3f2f0e-... (deterministic)", version: 5 } },
    },
    handler: (i) => {
      const nsIn = need(i, "namespace").toLowerCase();
      const ns = NS_ALIASES[nsIn] || nsIn;
      if (!UUID_RE.test(ns)) throw bad('"namespace" must be a UUID or one of: dns, url, oid, x500');
      const name = need(i, "name");
      const hash = createHash("sha1").update(Buffer.concat([uuidToBytes(ns), Buffer.from(name, "utf8")])).digest();
      const bytes = hash.subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
      return { uuid: bytesToUuid(bytes), version: 5, namespace: ns };
    },
  },
  {
    route: "POST /api/group-by", name: "Group by / aggregate", slug: "group-by", category: "conversion", price: "$0.001",
    description:
      "Group an array of objects by one or more keys and aggregate a numeric field — count (default), sum, avg, min, or max. The SQL GROUP BY agents reach for when wrangling JSON. Deterministic (groups in first-seen order).",
    tags: ["group-by", "aggregate", "sql", "pivot", "data"],
    discovery: {
      bodyType: "json",
      input: { data: [{ city: "NYC", n: 2 }, { city: "LA", n: 5 }, { city: "NYC", n: 3 }], by: "city", field: "n", op: "sum" },
      inputSchema: {
        properties: {
          data: { description: "array of objects (or JSON string)" },
          by: { description: "key name, or array of key names, to group by" },
          field: { type: "string", description: "numeric field to aggregate (omit for count only)" },
          op: { type: "string", description: "count (default) | sum | avg | min | max" },
        },
        required: ["data", "by"],
      },
      output: { example: { groups: [{ key: { city: "NYC" }, count: 2, sum: 5 }, { key: { city: "LA" }, count: 1, sum: 5 }], count: 2 } },
    },
    handler: (i) => {
      const data = parseMaybeJson(i.data, "data");
      if (!Array.isArray(data)) throw bad('"data" must be an array of objects');
      const keys = Array.isArray(i.by) ? i.by : [i.by];
      if (!keys.length || keys.some((k) => typeof k !== "string")) throw bad('"by" must be a key name or array of key names');
      const op = (i.op || "count").toLowerCase();
      if (!["count", "sum", "avg", "min", "max"].includes(op)) throw bad('"op" must be count | sum | avg | min | max');
      const field = i.field;
      if (op !== "count" && typeof field !== "string") throw bad(`"field" is required for op "${op}"`);

      const order = [];
      const map = new Map();
      for (const row of data) {
        if (typeof row !== "object" || row === null) throw bad("every element of data must be an object");
        const keyObj = Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
        const id = JSON.stringify(keys.map((k) => row[k] ?? null));
        if (!map.has(id)) { map.set(id, { key: keyObj, count: 0, _vals: [] }); order.push(id); }
        const g = map.get(id);
        g.count++;
        if (op !== "count") {
          const v = Number(row[field]);
          if (!Number.isFinite(v)) throw bad(`field "${field}" is not numeric in a "${id}" row`);
          g._vals.push(v);
        }
      }
      const groups = order.map((id) => {
        const g = map.get(id);
        const out = { key: g.key, count: g.count };
        if (op === "sum") out.sum = g._vals.reduce((a, b) => a + b, 0);
        else if (op === "avg") out.avg = g._vals.reduce((a, b) => a + b, 0) / g._vals.length;
        else if (op === "min") out.min = Math.min(...g._vals);
        else if (op === "max") out.max = Math.max(...g._vals);
        return out;
      });
      return { groups, count: groups.length };
    },
  },
  {
    route: "POST /api/json-to-xml", name: "JSON to XML", slug: "json-to-xml", category: "conversion", price: "$0.001",
    description:
      "Convert a JSON value to indented XML — the reverse of xml-to-json. Objects become nested elements, arrays repeat their tag, and text is escaped. Deterministic.",
    tags: ["json", "xml", "convert", "serialize"],
    discovery: {
      bodyType: "json",
      input: { data: { book: { title: "x", tags: ["a", "b"] } }, root: "root" },
      inputSchema: {
        properties: {
          data: { description: "the JSON value to serialize" },
          root: { type: "string", description: "name of the wrapping root element (default: root)" },
        },
        required: ["data"],
      },
      output: { example: { xml: "<root>\n  <book>\n    <title>x</title>\n  </book>\n</root>" } },
    },
    handler: (i) => {
      if (!("data" in i)) throw bad('Missing "data"');
      const data = parseMaybeJson(i.data, "data");
      const root = safeTag(typeof i.root === "string" && i.root ? i.root : "root");
      return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(data, root, 0)}` };
    },
  },
  {
    route: "POST /api/geo-distance", name: "Geo distance (haversine)", slug: "geo-distance", category: "math", price: "$0.001",
    description:
      "Great-circle distance between two latitude/longitude points using the haversine formula. Returns kilometers and miles. Deterministic.",
    tags: ["geo", "distance", "haversine", "latitude", "longitude"],
    discovery: {
      bodyType: "json",
      input: { from: { lat: 40.7128, lng: -74.006 }, to: { lat: 34.0522, lng: -118.2437 } },
      inputSchema: {
        properties: {
          from: { type: "object", description: "{ lat, lng } in decimal degrees" },
          to: { type: "object", description: "{ lat, lng } in decimal degrees" },
        },
        required: ["from", "to"],
      },
      output: { example: { km: 3935.75, miles: 2445.56 } },
    },
    handler: (i) => {
      const pt = (p, label) => {
        const o = parseMaybeJson(p, label);
        if (typeof o !== "object" || o === null) throw bad(`"${label}" must be { lat, lng }`);
        const lat = Number(o.lat), lng = Number(o.lng);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad(`"${label}.lat" must be a number in [-90, 90]`);
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw bad(`"${label}.lng" must be a number in [-180, 180]`);
        return { lat, lng };
      };
      const a = pt(i.from, "from"), b = pt(i.to, "to");
      const R = 6371; // km
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
      return { km: +km.toFixed(2), miles: +(km * 0.621371).toFixed(2) };
    },
  },
  {
    route: "POST /api/color-contrast", name: "Color contrast (WCAG)", slug: "color-contrast", category: "validation", price: "$0.001",
    description:
      "Compute the WCAG 2.x contrast ratio between two colors (hex #rgb or #rrggbb) and whether it passes AA/AAA for normal and large text. Deterministic — for accessible color choices without a tool in the loop.",
    tags: ["color", "contrast", "wcag", "accessibility", "a11y"],
    discovery: {
      bodyType: "json",
      input: { foreground: "#777777", background: "#ffffff" },
      inputSchema: {
        properties: {
          foreground: { type: "string", description: "text color (#rgb or #rrggbb)" },
          background: { type: "string", description: "background color (#rgb or #rrggbb)" },
        },
        required: ["foreground", "background"],
      },
      output: { example: { ratio: 4.48, AA: { normal: false, large: true }, AAA: { normal: false, large: false } } },
    },
    handler: (i) => {
      const fg = relLuminance(hexToRgb(need(i, "foreground")));
      const bg = relLuminance(hexToRgb(need(i, "background")));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      const r = +ratio.toFixed(2);
      return {
        ratio: r,
        AA: { normal: r >= 4.5, large: r >= 3 },
        AAA: { normal: r >= 7, large: r >= 4.5 },
      };
    },
  },
];
