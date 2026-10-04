// Crypto-hash kit — key derivation (PBKDF2, scrypt, HKDF), constant-time
// comparison, and multi-digest checksumming. The primitives an agent needs
// when building or verifying password hashing, token derivation, or file
// integrity workflows.
//
// Built entirely on node:crypto (stdlib, no new deps). All pure CPU, no
// network, no LLM -> automatically proof-of-work eligible (free tier).
import { createHash } from "node:crypto";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function need(input, field) {
  const v = input[field];
  if (typeof v !== "string") throw bad(`Missing or invalid "${field}"`);
  return v;
}

// Validate a positive integer within bounds, returning a default when absent.
function intOpt(input, field, defaultVal, min, max) {
  if (input[field] === undefined || input[field] === null) return defaultVal;
  const n = Number(input[field]);
  if (!Number.isInteger(n) || n < min || n > max)
    throw bad(`"${field}" must be an integer between ${min} and ${max}`);
  return n;
}

// Allowed hash digests for PBKDF2 / HKDF. node:crypto supports more, but
// these cover every real-world use case and keep the attack surface small.
const ALLOWED_DIGESTS = new Set(["sha1", "sha256", "sha384", "sha512"]);

function validDigest(input, field, defaultVal) {
  const v = (input[field] || defaultVal).toLowerCase();
  if (!ALLOWED_DIGESTS.has(v))
    throw bad(`"${field}" must be one of: ${[...ALLOWED_DIGESTS].join(", ")}`);
  return v;
}

// ---------------------------------------------------------------------------
// CRC32 — table-based implementation (IEEE polynomial 0xEDB88320)
// ---------------------------------------------------------------------------
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
export const CRYPTO_HASH_TOOLS = [




  // ---------------------------------------------------------------------------
  // 5. Checksum (multi-digest)
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/checksum", name: "Multi-digest checksum", slug: "checksum",
    category: "crypto", price: "$0.001",
    description:
      "Compute MD5, SHA-1, SHA-256, SHA-512, and CRC32 checksums of a string in a single call. Useful for verifying file or payload integrity across different checksum standards without needing five separate tools.",
    tags: ["checksum", "md5", "sha1", "sha256", "sha512", "crc32", "integrity", "hash", "digest"],
    discovery: {
      bodyType: "json",
      input: { data: "hello world" },
      inputSchema: {
        properties: {
          data: { type: "string", description: "The string to compute checksums for (max 10MB)" },
        },
        required: ["data"],
      },
      output: {
        example: {
          md5: "5eb63bbbe01eeed093cb22bb8f5acdc3",
          sha1: "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed",
          sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
          sha512: "309ecc489c12d6eb4cc40f50c902f2b4d0ed77ee511a7c7a9bcd3ca86d4cd86f989dd35bc5ff499670da34255b45b0cfd830e81f605dcf7dc5542e93ae9cd76f",
          crc32: "0d4a1185",
        },
      },
    },
    handler: (i) => {
      const data = need(i, "data");
      // 10MB cap — same limit used by compression-kit; generous for any
      // JSON-over-HTTP payload an agent would realistically send.
      if (data.length > 10 * 1024 * 1024) throw bad('"data" exceeds 10MB limit');

      const buf = Buffer.from(data, "utf8");

      return {
        md5: createHash("md5").update(buf).digest("hex"),
        sha1: createHash("sha1").update(buf).digest("hex"),
        sha256: createHash("sha256").update(buf).digest("hex"),
        sha512: createHash("sha512").update(buf).digest("hex"),
        crc32: crc32(buf),
      };
    },
  },
];
