// Util-kit — deterministic gap-fillers that round out the catalog's existing
// families: jwt-sign (completes decode/verify/sign), uuid-v5 (deterministic IDs
// to pair with the random uuid/ulid), group-by (the data-wrangling aggregate
// agents reach for), json-to-xml (reverse of xml-to-json), geo-distance
// (haversine), color-contrast (WCAG), and webhook-verify (per-provider HMAC
// signature check: GitHub/Stripe/Shopify/Slack). All pure-CPU, no network, no
// LLM — proof-of-work eligible. Covered by scripts/test-util-kit.js and
// scripts/test-webhook-verify.js.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

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

// webhook-verify: each provider signs the RAW request body with its own base
// string + encoding. Getting the base string wrong fails silently, so this
// tool encodes each scheme exactly. Final comparisons are constant-time
// (timingSafeEqual after a length guard) and the secret is never echoed.
const HEX_RE = /^[0-9a-f]+$/;
const ctEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const ctEqualHex = (expectedHex, providedHex) => ctEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(providedHex, "utf8"));
const hmacHex = (algo, secret, data) => createHmac(algo, secret).update(data, "utf8").digest("hex");

function requireTimestamp(provider, raw) {
  if (raw === undefined || raw === null || raw === "") {
    throw bad(`"timestamp" is required for ${provider} (${provider === "stripe" ? 'Stripe-Signature "t=" value' : "X-Slack-Request-Timestamp header"})`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw bad(`"timestamp" must be a unix-epoch integer in seconds (got a non-numeric value)`);
  return s;
}

// Returns a { valid:false, ... } replay rejection when the timestamp falls
// outside toleranceSeconds, else null (with the age recorded on `meta`).
function replayCheck(tsStr, toleranceSeconds, meta) {
  if (toleranceSeconds === 0) return null;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(tsStr));
  meta.timestampAgeSeconds = age;
  if (age <= toleranceSeconds) return null;
  return `timestamp is ${age}s from now, outside the ${toleranceSeconds}s replay tolerance (set toleranceSeconds: 0 to skip the age check)`;
}

const WEBHOOK_SCHEMES = {
  github(payload, secret, signature) {
    const raw = signature.trim();
    const legacy = /^sha1=/i.test(raw);
    const algo = legacy ? "sha1" : "sha256";
    const hex = raw.replace(/^sha(256|1)=/i, "").toLowerCase();
    if (!HEX_RE.test(hex)) throw bad("malformed signature: expected a hex digest, optionally prefixed with sha256= (X-Hub-Signature-256) or sha1= (legacy X-Hub-Signature)");
    return {
      valid: ctEqualHex(hmacHex(algo, secret, payload), hex),
      scheme: legacy
        ? "X-Hub-Signature (legacy): sha1=hex(HMAC-SHA1(secret, rawBody)) - prefer X-Hub-Signature-256"
        : "X-Hub-Signature-256: sha256=hex(HMAC-SHA256(secret, rawBody))",
    };
  },
  stripe(payload, secret, signature, input, meta) {
    let ts = input.timestamp;
    let v1s = [];
    const raw = signature.trim();
    if (raw.includes("=")) {
      for (const part of raw.split(",")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === "t" && (ts === undefined || ts === null || ts === "")) ts = v;
        else if (k === "v1") v1s.push(v.toLowerCase());
      }
      if (!v1s.length) throw bad('malformed Stripe-Signature: no "v1" element found (expected "t=<ts>,v1=<hex>")');
    } else {
      v1s = [raw.toLowerCase()];
    }
    if (v1s.some((v) => !HEX_RE.test(v))) throw bad("malformed signature: every Stripe v1 value must be a hex digest");
    const tsStr = requireTimestamp("stripe", ts);
    const replay = replayCheck(tsStr, meta.toleranceSeconds, meta);
    const expected = hmacHex("sha256", secret, `${tsStr}.${payload}`);
    // Evaluate every candidate (no short-circuit) so timing doesn't reveal which v1 matched.
    const matched = v1s.map((v) => ctEqualHex(expected, v)).includes(true);
    return {
      valid: !replay && matched,
      reason: replay || (matched ? null : undefined),
      scheme: 'Stripe-Signature: v1=hex(HMAC-SHA256(secret, "<t>.<rawBody>")) with t replay tolerance',
    };
  },
  shopify(payload, secret, signature) {
    const raw = signature.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw bad("malformed signature: expected base64 (X-Shopify-Hmac-Sha256)");
    const provided = Buffer.from(raw, "base64");
    return {
      valid: ctEqual(createHmac("sha256", secret).update(payload, "utf8").digest(), provided),
      scheme: "X-Shopify-Hmac-Sha256: base64(HMAC-SHA256(secret, rawBody))",
    };
  },
  slack(payload, secret, signature, input, meta) {
    const hex = signature.trim().replace(/^v0=/i, "").toLowerCase();
    if (!HEX_RE.test(hex)) throw bad("malformed signature: expected v0=<hex> (X-Slack-Signature)");
    const tsStr = requireTimestamp("slack", input.timestamp);
    const replay = replayCheck(tsStr, meta.toleranceSeconds, meta);
    const matched = ctEqualHex(hmacHex("sha256", secret, `v0:${tsStr}:${payload}`), hex);
    return {
      valid: !replay && matched,
      reason: replay || (matched ? null : undefined),
      scheme: 'X-Slack-Signature: v0=hex(HMAC-SHA256(secret, "v0:<timestamp>:<rawBody>")) with timestamp replay tolerance',
    };
  },
};

export const UTIL_TOOLS = [



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





  // Restored 2026-08-30 with the packs that compose them (skill-jwt-toolkit,
  // skill-webhook-intake). Retired 08-25 on a use figure that was capped at 20
  // by a LIMIT in the ledger query - see src/sales-ledger.js.
  {
    route: "POST /api/jwt-sign", name: "JWT sign", slug: "jwt-sign", category: "encoding", price: "$0.001",
    description:
      "Mint a signed JSON Web Token (HMAC: HS256 default, HS384, HS512) from a payload + secret. Pairs with jwt-decode/jwt-verify to complete the trio. Deterministic - same payload, secret, and alg always produce the same token.",
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
    route: "POST /api/webhook-verify", name: "Webhook signature verify", slug: "webhook-verify", category: "validation", price: "$0.001",
    description:
      "Verify a webhook's HMAC signature against the correct per-provider scheme: GitHub (X-Hub-Signature-256, sha256=hex), Stripe (Stripe-Signature t/v1 over \"<t>.<body>\" with replay tolerance), Shopify (X-Shopify-Hmac-Sha256, base64), Slack (X-Slack-Signature, v0:<ts>:<body> with replay tolerance). Constant-time comparison; the secret is never echoed. Pass the RAW request body string - signatures are over the raw bytes. Deterministic.",
    tags: ["webhook", "hmac", "signature", "security", "github", "stripe", "shopify", "slack"],
    discovery: {
      bodyType: "json",
      input: { provider: "github", payload: '{"hello":"world"}', secret: "it's a secret", signature: "sha256=8d4063f0a81aa1531d9891a028a68cf2bb537ecdf0e82557674d71e168d570f9" },
      inputSchema: {
        properties: {
          provider: { type: "string", description: "github | stripe | shopify | slack" },
          payload: { type: "string", description: "the RAW request body string, byte-for-byte as received (never a re-serialized object)" },
          secret: { type: "string", description: "the provider signing secret (never echoed back)" },
          signature: { type: "string", description: "the signature header value, with or without its scheme prefix (sha256= / v0= / t=...,v1=...)" },
          timestamp: { type: "string", description: "provider timestamp, required for stripe + slack (stripe may be parsed from a t= element in the signature)" },
          toleranceSeconds: { type: "number", description: "max timestamp age for stripe/slack replay protection (default 300; 0 skips the age check)" },
        },
        required: ["provider", "payload", "secret", "signature"],
      },
      output: { example: { valid: true, provider: "github", scheme: "X-Hub-Signature-256: sha256=hex(HMAC-SHA256(secret, rawBody))", reason: "signature matches the recomputed HMAC for this payload and secret" } },
    },
    handler: (i) => {
      const provider = need(i, "provider").trim().toLowerCase();
      const verify = WEBHOOK_SCHEMES[provider];
      if (!verify) throw bad(`unsupported "provider" (github | stripe | shopify | slack)`);
      if (typeof i.payload !== "string") throw bad('"payload" must be the RAW request body as a string - webhook signatures are computed over the raw bytes, so a parsed-then-restringified JSON object will not match. Pass the body exactly as received.');
      const secret = need(i, "secret");
      const signature = need(i, "signature");
      const tol = i.toleranceSeconds === undefined || i.toleranceSeconds === null ? 300 : Number(i.toleranceSeconds);
      if (!Number.isFinite(tol) || tol < 0) throw bad('"toleranceSeconds" must be a number >= 0 (0 skips the age check)');

      const meta = { toleranceSeconds: tol };
      const r = verify(i.payload, secret, signature, i, meta);
      const out = {
        valid: r.valid,
        provider,
        scheme: r.scheme,
        reason: r.valid
          ? "signature matches the recomputed HMAC for this payload and secret"
          : (r.reason || "signature does not match the recomputed HMAC for this payload and secret"),
      };
      if (meta.timestampAgeSeconds !== undefined) out.timestampAgeSeconds = meta.timestampAgeSeconds;
      return out;
    },
  },

];
