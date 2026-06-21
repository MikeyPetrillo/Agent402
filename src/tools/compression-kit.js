// Compression kit — gzip / brotli / deflate primitives that agents need
// constantly: inspecting a base64-encoded payload, decompressing a gzipped
// API response someone pasted in, or comparing which algorithm gives the
// best ratio before uploading.
//
// Built entirely on node:zlib (stdlib, no new deps). All pure CPU, no
// network, no LLM → automatically proof-of-work eligible (free tier).
// Covered by scripts/test-compression-kit.js.
import {
  gzipSync, gunzipSync,
  brotliCompressSync, brotliDecompressSync,
  deflateRawSync,
} from "node:zlib";

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

// Cap input + output to defend against zip bombs (a 10KB gzip can decompress
// to gigabytes). 10MB is more than any reasonable JSON-over-HTTP payload.
const MAX_BYTES = 10 * 1024 * 1024;

// Decode user-supplied input to a Buffer, honoring the declared format.
// utf8 is the default for compress (most callers paste raw text); base64 is
// the default for decompress (compressed bytes don't survive JSON otherwise).
function toBuffer(value, format, field) {
  if (format === "utf8") return Buffer.from(value, "utf8");
  if (format === "base64") {
    // Strict base64 — reject garbage so callers don't get silent partial bytes.
    if (!/^[A-Za-z0-9+/=\s]*$/.test(value)) throw bad(`"${field}" is not valid base64`);
    return Buffer.from(value, "base64");
  }
  if (format === "hex") {
    if (!/^[0-9a-fA-F\s]*$/.test(value)) throw bad(`"${field}" is not valid hex`);
    return Buffer.from(value.replace(/\s+/g, ""), "hex");
  }
  throw bad(`"${field}Format" must be one of: utf8, base64, hex`);
}

// Encode a Buffer back out for the response. Compressed bytes always come
// out as base64 (they're not human-readable); decompressed content can be
// utf8 (text) or base64 (binary).
function fromBuffer(buf, format) {
  if (format === "base64") return buf.toString("base64");
  if (format === "hex") return buf.toString("hex");
  if (format === "utf8") return buf.toString("utf8");
  throw bad(`outputFormat must be one of: utf8, base64, hex`);
}

function ratio(inBytes, outBytes) {
  if (inBytes === 0) return 0;
  // Negative ratio when output is larger than input (common for tiny inputs
  // due to algorithm headers). Express as a unitless fraction, 4 decimals.
  return Math.round((1 - outBytes / inBytes) * 10000) / 10000;
}

export const COMPRESSION_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/gzip", name: "Gzip compress", slug: "gzip",
    category: "data", price: "$0.001",
    description:
      "Compress a string with gzip (RFC 1952) and return it as base64. Reports input bytes, output bytes, and the compression ratio so you can decide if it was worth doing. Input can be plain text (utf8) or already-binary content (base64 or hex).",
    tags: ["gzip", "compress", "zlib", "rfc1952", "encoding"],
    discovery: {
      bodyType: "json",
      input: { input: "hello hello hello hello hello hello hello", inputFormat: "utf8" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Content to compress (max 10MB after decoding)" },
          inputFormat: { type: "string", description: "How `input` is encoded: utf8 (default), base64, or hex" },
          level: { type: "number", description: "Compression level 1-9 (default 9 = best ratio, slower)" },
        },
        required: ["input"],
      },
      output: { example: { algorithm: "gzip", inputBytes: 41, outputBytes: 21, ratio: 0.4878, output: "H4sIAA…" } },
    },
    handler: (i) => {
      const input = need(i, "input");
      const inputFormat = i.inputFormat || "utf8";
      const buf = toBuffer(input, inputFormat, "input");
      if (buf.length > MAX_BYTES) throw bad(`input exceeds ${MAX_BYTES} byte limit`);
      const level = i.level === undefined ? 9 : Number(i.level);
      if (!Number.isInteger(level) || level < 1 || level > 9) throw bad(`"level" must be an integer 1-9`);
      const out = gzipSync(buf, { level });
      return {
        algorithm: "gzip",
        inputBytes: buf.length,
        outputBytes: out.length,
        ratio: ratio(buf.length, out.length),
        output: out.toString("base64"),
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/gunzip", name: "Gzip decompress", slug: "gunzip",
    category: "data", price: "$0.001",
    description:
      "Decompress a base64-encoded gzip payload. Returns the result as utf8 (text) or base64 (binary). Refuses to expand past 10MB to defend against zip bombs.",
    tags: ["gunzip", "decompress", "zlib", "rfc1952"],
    discovery: {
      bodyType: "json",
      input: { input: "H4sIAAAAAAAACstIzcnJVyjPL8pJUQQAbcK0AwwAAAA=", outputFormat: "utf8" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Base64-encoded gzip bytes" },
          inputFormat: { type: "string", description: "How `input` is encoded: base64 (default) or hex" },
          outputFormat: { type: "string", description: "Result encoding: utf8 (default, for text) or base64 (for binary)" },
        },
        required: ["input"],
      },
      output: { example: { algorithm: "gzip", inputBytes: 32, outputBytes: 12, output: "hello world!" } },
    },
    handler: (i) => {
      const input = need(i, "input");
      const inputFormat = i.inputFormat || "base64";
      const outputFormat = i.outputFormat || "utf8";
      const buf = toBuffer(input, inputFormat, "input");
      if (buf.length > MAX_BYTES) throw bad(`input exceeds ${MAX_BYTES} byte limit`);
      let out;
      try {
        out = gunzipSync(buf, { maxOutputLength: MAX_BYTES });
      } catch (e) {
        throw bad(`gzip decode failed: ${e.message}`);
      }
      return {
        algorithm: "gzip",
        inputBytes: buf.length,
        outputBytes: out.length,
        output: fromBuffer(out, outputFormat),
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/brotli-compress", name: "Brotli compress", slug: "brotli-compress",
    category: "data", price: "$0.001",
    description:
      "Compress a string with Brotli (RFC 7932) and return it as base64. Brotli typically beats gzip by 15-25% on text — useful when bytes matter (e.g. cramming context into an LLM prompt, fitting under a transport cap). Slower than gzip; pick gzip if speed matters more than ratio.",
    tags: ["brotli", "compress", "rfc7932", "encoding"],
    discovery: {
      bodyType: "json",
      input: { input: "hello hello hello hello hello hello hello", inputFormat: "utf8" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Content to compress (max 10MB after decoding)" },
          inputFormat: { type: "string", description: "How `input` is encoded: utf8 (default), base64, or hex" },
          quality: { type: "number", description: "Brotli quality 0-11 (default 11 = best ratio, slowest)" },
        },
        required: ["input"],
      },
      output: { example: { algorithm: "brotli", inputBytes: 41, outputBytes: 15, ratio: 0.6341, output: "GygAAAB…" } },
    },
    handler: (i) => {
      const input = need(i, "input");
      const inputFormat = i.inputFormat || "utf8";
      const buf = toBuffer(input, inputFormat, "input");
      if (buf.length > MAX_BYTES) throw bad(`input exceeds ${MAX_BYTES} byte limit`);
      const quality = i.quality === undefined ? 11 : Number(i.quality);
      if (!Number.isInteger(quality) || quality < 0 || quality > 11) throw bad(`"quality" must be an integer 0-11`);
      const out = brotliCompressSync(buf, { params: { 1: quality } }); // 1 = BROTLI_PARAM_QUALITY
      return {
        algorithm: "brotli",
        inputBytes: buf.length,
        outputBytes: out.length,
        ratio: ratio(buf.length, out.length),
        output: out.toString("base64"),
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/brotli-decompress", name: "Brotli decompress", slug: "brotli-decompress",
    category: "data", price: "$0.001",
    description:
      "Decompress a base64-encoded Brotli payload. Returns the result as utf8 (text) or base64 (binary). Refuses to expand past 10MB to defend against zip bombs.",
    tags: ["brotli", "decompress", "rfc7932"],
    discovery: {
      bodyType: "json",
      input: { input: "iwWAaGVsbG8gd29ybGQhAw==", outputFormat: "utf8" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Base64-encoded Brotli bytes" },
          inputFormat: { type: "string", description: "How `input` is encoded: base64 (default) or hex" },
          outputFormat: { type: "string", description: "Result encoding: utf8 (default, for text) or base64 (for binary)" },
        },
        required: ["input"],
      },
      output: { example: { algorithm: "brotli", inputBytes: 16, outputBytes: 12, output: "hello world!" } },
    },
    handler: (i) => {
      const input = need(i, "input");
      const inputFormat = i.inputFormat || "base64";
      const outputFormat = i.outputFormat || "utf8";
      const buf = toBuffer(input, inputFormat, "input");
      if (buf.length > MAX_BYTES) throw bad(`input exceeds ${MAX_BYTES} byte limit`);
      let out;
      try {
        out = brotliDecompressSync(buf, { maxOutputLength: MAX_BYTES });
      } catch (e) {
        throw bad(`brotli decode failed: ${e.message}`);
      }
      return {
        algorithm: "brotli",
        inputBytes: buf.length,
        outputBytes: out.length,
        output: fromBuffer(out, outputFormat),
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/compress-compare", name: "Compression compare", slug: "compress-compare",
    category: "data", price: "$0.001",
    description:
      "Run the same input through gzip, brotli, and raw deflate at max settings and report each one's output size and ratio. Use this to decide which algorithm to actually use — the answer depends on your content (binary often resists compression entirely; English prose squeezes well with brotli; JSON sits in between).",
    tags: ["compress", "benchmark", "ratio", "gzip", "brotli", "deflate"],
    discovery: {
      bodyType: "json",
      input: { input: "the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog", inputFormat: "utf8" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Content to test (max 10MB after decoding)" },
          inputFormat: { type: "string", description: "How `input` is encoded: utf8 (default), base64, or hex" },
        },
        required: ["input"],
      },
      output: {
        example: {
          inputBytes: 87,
          results: [
            { algorithm: "brotli", outputBytes: 28, ratio: 0.6782 },
            { algorithm: "gzip", outputBytes: 41, ratio: 0.5287 },
            { algorithm: "deflate", outputBytes: 29, ratio: 0.6667 },
          ],
          best: "brotli",
        },
      },
    },
    handler: (i) => {
      const input = need(i, "input");
      const inputFormat = i.inputFormat || "utf8";
      const buf = toBuffer(input, inputFormat, "input");
      if (buf.length > MAX_BYTES) throw bad(`input exceeds ${MAX_BYTES} byte limit`);

      const gz = gzipSync(buf, { level: 9 });
      const br = brotliCompressSync(buf, { params: { 1: 11 } });
      const df = deflateRawSync(buf, { level: 9 });

      const results = [
        { algorithm: "gzip",    outputBytes: gz.length, ratio: ratio(buf.length, gz.length) },
        { algorithm: "brotli",  outputBytes: br.length, ratio: ratio(buf.length, br.length) },
        { algorithm: "deflate", outputBytes: df.length, ratio: ratio(buf.length, df.length) },
      ];
      // Sort by smallest output first so "best" is unambiguous on ties.
      results.sort((a, b) => a.outputBytes - b.outputBytes);
      return {
        inputBytes: buf.length,
        results,
        best: results[0].algorithm,
      };
    },
  },
];
