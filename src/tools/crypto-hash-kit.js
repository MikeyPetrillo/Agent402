// Crypto-hash kit — key derivation (PBKDF2, scrypt, HKDF), constant-time
// comparison, and multi-digest checksumming. The primitives an agent needs
// when building or verifying password hashing, token derivation, or file
// integrity workflows.
//
// Built entirely on node:crypto (stdlib, no new deps). All pure CPU, no
// network, no LLM -> automatically proof-of-work eligible (free tier).
import {
  createHash, createHmac,
  pbkdf2Sync, scryptSync, hkdfSync, timingSafeEqual,
} from "node:crypto";

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
  // 1. PBKDF2
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/pbkdf2", name: "PBKDF2 key derivation", slug: "pbkdf2",
    category: "crypto", price: "$0.001",
    description:
      "Derive a cryptographic key from a password using PBKDF2 (RFC 8018). Returns the hex-encoded derived key along with all parameters used, so you can store or verify them later. Supports sha1, sha256, sha384, sha512 digests.",
    tags: ["pbkdf2", "kdf", "key-derivation", "password", "hashing", "crypto"],
    discovery: {
      bodyType: "json",
      input: { password: "hunter2", salt: "random-salt-value", iterations: 100000, keyLength: 32, digest: "sha256" },
      inputSchema: {
        properties: {
          password: { type: "string", description: "Password or passphrase to derive from" },
          salt: { type: "string", description: "Salt string (should be unique per password)" },
          iterations: { type: "integer", description: "Iteration count (default 100000, max 1000000)" },
          keyLength: { type: "integer", description: "Desired key length in bytes (default 32, max 128)" },
          digest: { type: "string", description: "Hash algorithm: sha1, sha256, sha384, sha512 (default sha256)" },
        },
        required: ["password", "salt"],
      },
      output: {
        example: {
          derivedKey: "a1b2c3d4e5f6...",
          algorithm: "pbkdf2",
          digest: "sha256",
          iterations: 100000,
          keyLength: 32,
          saltUsed: "random-salt-value",
        },
      },
    },
    handler: (i) => {
      const password = need(i, "password");
      const salt = need(i, "salt");
      const iterations = intOpt(i, "iterations", 100000, 1, 1000000);
      const keyLength = intOpt(i, "keyLength", 32, 1, 128);
      const digest = validDigest(i, "digest", "sha256");

      const derived = pbkdf2Sync(password, salt, iterations, keyLength, digest);

      return {
        derivedKey: derived.toString("hex"),
        algorithm: "pbkdf2",
        digest,
        iterations,
        keyLength,
        saltUsed: salt,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 2. scrypt
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/scrypt-derive", name: "scrypt key derivation", slug: "scrypt-derive",
    category: "crypto", price: "$0.001",
    description:
      "Derive a cryptographic key from a password using scrypt (RFC 7914). Memory-hard by design, making it more resistant to GPU/ASIC brute-force than PBKDF2. Returns the hex-encoded derived key and all tuning parameters (N, r, p).",
    tags: ["scrypt", "kdf", "key-derivation", "password", "hashing", "crypto", "memory-hard"],
    discovery: {
      bodyType: "json",
      input: { password: "hunter2", salt: "random-salt-value", keyLength: 64, cost: 16384, blockSize: 8, parallelization: 1 },
      inputSchema: {
        properties: {
          password: { type: "string", description: "Password or passphrase to derive from" },
          salt: { type: "string", description: "Salt string (should be unique per password)" },
          keyLength: { type: "integer", description: "Desired key length in bytes (default 64, max 128)" },
          cost: { type: "integer", description: "CPU/memory cost parameter N (default 16384, max 131072, must be power of 2)" },
          blockSize: { type: "integer", description: "Block size parameter r (default 8)" },
          parallelization: { type: "integer", description: "Parallelization parameter p (default 1)" },
        },
        required: ["password", "salt"],
      },
      output: {
        example: {
          derivedKey: "a1b2c3d4e5f6...",
          algorithm: "scrypt",
          cost: 16384,
          blockSize: 8,
          parallelization: 1,
          keyLength: 64,
          saltUsed: "random-salt-value",
        },
      },
    },
    handler: (i) => {
      const password = need(i, "password");
      const salt = need(i, "salt");
      const keyLength = intOpt(i, "keyLength", 64, 1, 128);
      const cost = intOpt(i, "cost", 16384, 2, 131072);
      const blockSize = intOpt(i, "blockSize", 8, 1, 64);
      const parallelization = intOpt(i, "parallelization", 1, 1, 16);

      // scrypt requires N to be a power of 2
      if ((cost & (cost - 1)) !== 0) throw bad('"cost" (N) must be a power of 2');

      const derived = scryptSync(password, salt, keyLength, {
        N: cost, r: blockSize, p: parallelization,
      });

      return {
        derivedKey: derived.toString("hex"),
        algorithm: "scrypt",
        cost,
        blockSize,
        parallelization,
        keyLength,
        saltUsed: salt,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 3. HKDF
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/hkdf-expand", name: "HKDF extract-and-expand", slug: "hkdf-expand",
    category: "crypto", price: "$0.001",
    description:
      "HKDF extract-then-expand (RFC 5869) — derive output keying material from initial keying material, an optional salt, and an optional info/context string. Useful for deriving multiple keys from a single shared secret. Returns hex-encoded OKM.",
    tags: ["hkdf", "kdf", "key-derivation", "rfc5869", "crypto", "extract", "expand"],
    discovery: {
      bodyType: "json",
      input: { ikm: "shared-secret-material", salt: "optional-salt", info: "context-string", keyLength: 32, digest: "sha256" },
      inputSchema: {
        properties: {
          ikm: { type: "string", description: "Initial keying material (the shared secret)" },
          salt: { type: "string", description: "Optional salt (empty string if omitted)" },
          info: { type: "string", description: "Optional context/application info (empty string if omitted)" },
          keyLength: { type: "integer", description: "Desired output key length in bytes (default 32, max 128)" },
          digest: { type: "string", description: "Hash algorithm: sha1, sha256, sha384, sha512 (default sha256)" },
        },
        required: ["ikm"],
      },
      output: {
        example: {
          okm: "a1b2c3d4e5f6...",
          algorithm: "hkdf",
          digest: "sha256",
          keyLength: 32,
        },
      },
    },
    handler: (i) => {
      const ikm = need(i, "ikm");
      const salt = typeof i.salt === "string" ? i.salt : "";
      const info = typeof i.info === "string" ? i.info : "";
      const keyLength = intOpt(i, "keyLength", 32, 1, 128);
      const digest = validDigest(i, "digest", "sha256");

      const okm = hkdfSync(digest, ikm, salt, info, keyLength);

      return {
        okm: Buffer.from(okm).toString("hex"),
        algorithm: "hkdf",
        digest,
        keyLength,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 4. Constant-time compare
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/constant-compare", name: "Constant-time compare", slug: "constant-compare",
    category: "crypto", price: "$0.001",
    description:
      "Compare two strings in constant time using node:crypto timingSafeEqual, preventing timing side-channel attacks. Returns whether the strings are equal and whether their lengths match. Different-length strings are always unequal but comparison does not leak which is longer via timing.",
    tags: ["timing-safe", "constant-time", "compare", "security", "side-channel", "crypto"],
    discovery: {
      bodyType: "json",
      input: { a: "expected-token-value", b: "actual-token-value" },
      inputSchema: {
        properties: {
          a: { type: "string", description: "First string to compare" },
          b: { type: "string", description: "Second string to compare" },
        },
        required: ["a", "b"],
      },
      output: {
        example: { equal: false, lengthMatch: false },
      },
    },
    handler: (i) => {
      const a = need(i, "a");
      const b = need(i, "b");

      const bufA = Buffer.from(a, "utf8");
      const bufB = Buffer.from(b, "utf8");

      const lengthMatch = bufA.length === bufB.length;

      // timingSafeEqual requires equal-length buffers. When lengths differ,
      // the strings can't be equal — but we still need to avoid leaking
      // which is longer via timing. Hash both to a fixed-length digest and
      // compare those; the hash comparison runs in constant time regardless
      // of the original lengths.
      let equal;
      if (lengthMatch) {
        equal = timingSafeEqual(bufA, bufB);
      } else {
        const ha = createHash("sha256").update(bufA).digest();
        const hb = createHash("sha256").update(bufB).digest();
        timingSafeEqual(ha, hb); // run the comparison for constant-time behavior
        equal = false; // different lengths are never equal
      }

      return { equal, lengthMatch };
    },
  },

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
