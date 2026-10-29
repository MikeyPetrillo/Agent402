// Crypto-hash kit — multi-digest checksumming (MD5, SHA-1, SHA-256, SHA-512,
// CRC32) for payload and file integrity workflows.
//
// Built entirely on node:crypto (stdlib, no new deps). All pure CPU, no
// network, no LLM -> automatically proof-of-work eligible (free tier).
import { createHash } from "node:crypto";
import zlib from "node:zlib";

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

// CRC-32 (IEEE) as 8 lowercase hex digits.
const crc32 = (buf) => (zlib.crc32(buf) >>> 0).toString(16).padStart(8, "0");

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
