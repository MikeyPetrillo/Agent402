// Agent-kit — the deterministic tools an agent building on top of an LLM needs
// most: exact token counting, RAG-style chunking, JSON-Schema validation, and
// JSONL <-> array conversion. All pure-CPU (proof-of-work eligible), no network,
// no LLM in the serving path. Covered by scripts/test-agent-kit.js.

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
function cap(text, max = 200_000, label = "text") {
  if (typeof text !== "string") throw bad(`"${label}" must be a string`);
  if (text.length > max) throw bad(`"${label}" exceeds ${max} characters`);
  return text;
}
const parseMaybeJson = (v, label) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { throw bad(`"${label}" is not valid JSON: ${e.message}`); }
};
const clampInt = (v, dflt, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
};

// ---------------------------------------------------------------------------
// Token counting / chunking — exact OpenAI BPE via gpt-tokenizer (lazy-loaded,
// cached for the process). cl100k_base covers gpt-4 / gpt-3.5 / ada-002;
// o200k_base covers gpt-4o / o-series. These are the de-facto token counts
// agents budget context against.
let encCl100k, encO200k;
async function getEncoder(model = "gpt-4o") {
  const m = String(model).toLowerCase();
  if (/4o|o1\b|o3|o4|gpt-5|omni|o200k/.test(m)) {
    encO200k ??= await import("gpt-tokenizer/model/gpt-4o");
    return { enc: encO200k, encoding: "o200k_base" };
  }
  encCl100k ??= await import("gpt-tokenizer");
  return { enc: encCl100k, encoding: "cl100k_base" };
}

// ---------------------------------------------------------------------------
// Minimal but correct JSON Schema validator (draft-07 subset). Supported:
// type, enum, const, required, properties, additionalProperties (bool|schema),
// items (schema), minItems/maxItems, uniqueItems, minimum/maximum +exclusive,
// minLength/maxLength, pattern, format (email|uri|uuid|date-time|ipv4),
// anyOf/allOf/oneOf/not, nullable. Keywords outside this set are ignored
// (documented), never silently "passing" something it claims to check.
const FORMATS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
};
const jsonType = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v === "number" ? "number" : typeof v;

function validateNode(data, schema, path, errors) {
  if (typeof schema !== "object" || schema === null) return;
  const at = path || "(root)";

  if (schema.nullable && data === null) return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = jsonType(data);
    const ok = types.some((want) => want === t || (want === "number" && t === "integer"));
    if (!ok) { errors.push(`${at}: expected type ${types.join("|")}, got ${t}`); return; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data)))
    errors.push(`${at}: value not in enum`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(data))
    errors.push(`${at}: value !== const`);

  const t = jsonType(data);
  if (t === "string") {
    if (schema.minLength != null && data.length < schema.minLength) errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength != null && data.length > schema.maxLength) errors.push(`${at}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${at}: does not match pattern`);
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(data)) errors.push(`${at}: invalid ${schema.format}`);
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum != null && data < schema.minimum) errors.push(`${at}: less than minimum ${schema.minimum}`);
    if (schema.maximum != null && data > schema.maximum) errors.push(`${at}: greater than maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && data <= schema.exclusiveMinimum) errors.push(`${at}: not > exclusiveMinimum`);
    if (schema.exclusiveMaximum != null && data >= schema.exclusiveMaximum) errors.push(`${at}: not < exclusiveMaximum`);
  }
  if (t === "array") {
    if (schema.minItems != null && data.length < schema.minItems) errors.push(`${at}: fewer than minItems ${schema.minItems}`);
    if (schema.maxItems != null && data.length > schema.maxItems) errors.push(`${at}: more than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems) {
      const seen = new Set(data.map((x) => JSON.stringify(x)));
      if (seen.size !== data.length) errors.push(`${at}: items not unique`);
    }
    if (schema.items) data.forEach((v, i) => validateNode(v, schema.items, `${at}[${i}]`, errors));
  }
  if (t === "object") {
    for (const req of schema.required || []) if (!(req in data)) errors.push(`${at}: missing required "${req}"`);
    for (const [k, sub] of Object.entries(schema.properties || {}))
      if (k in data) validateNode(data[k], sub, `${at}.${k}`, errors);
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const k of Object.keys(data)) if (!allowed.has(k)) errors.push(`${at}: additional property "${k}" not allowed`);
    } else if (typeof schema.additionalProperties === "object") {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const k of Object.keys(data)) if (!allowed.has(k)) validateNode(data[k], schema.additionalProperties, `${at}.${k}`, errors);
    }
  }

  if (schema.not) { const e = []; validateNode(data, schema.not, at, e); if (e.length === 0) errors.push(`${at}: matches "not" schema`); }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validateNode(data, s, at, errors);
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => { const e = []; validateNode(data, s, at, e); return e.length === 0; });
    if (!ok) errors.push(`${at}: matches none of anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((s) => { const e = []; validateNode(data, s, at, e); return e.length === 0; }).length;
    if (matches !== 1) errors.push(`${at}: matches ${matches} of oneOf (need exactly 1)`);
  }
}

export const AGENT_TOOLS = [
  {
    route: "POST /api/token-count", name: "Token count", slug: "token-count", category: "text", price: "$0.001",
    description:
      "Count exact LLM tokens for a string using the real OpenAI BPE (o200k_base for gpt-4o/o-series, cl100k_base for gpt-4/gpt-3.5). Deterministic, offline — budget context windows without calling a model.",
    tags: ["tokens", "tokenizer", "context-window", "llm", "bpe"],
    discovery: {
      bodyType: "json",
      input: { text: "hello world", model: "gpt-4o" },
      inputSchema: { properties: { text: { type: "string" }, model: { type: "string", description: "gpt-4o (default, o200k) | gpt-4 / gpt-3.5 (cl100k)" } }, required: ["text"] },
      output: { example: { tokens: 2, characters: 11, model: "gpt-4o", encoding: "o200k_base" } },
    },
    handler: async (i) => {
      const text = cap(need(i, "text"));
      const { enc, encoding } = await getEncoder(i.model || "gpt-4o");
      return { tokens: enc.encode(text).length, characters: text.length, model: i.model || "gpt-4o", encoding };
    },
  },
  {
    route: "POST /api/text-chunk", name: "Text chunk (RAG)", slug: "text-chunk", category: "text", price: "$0.001",
    description:
      "Split text into overlapping chunks for RAG ingestion — by characters (default) or by exact LLM tokens. Returns the chunks plus offsets. Deterministic, no model needed.",
    tags: ["chunk", "rag", "split", "embeddings", "tokens"],
    discovery: {
      bodyType: "json",
      input: { text: "long document …", size: 800, overlap: 100, unit: "chars" },
      inputSchema: {
        properties: {
          text: { type: "string" },
          size: { type: "number", description: "chunk size (default 800)" },
          overlap: { type: "number", description: "overlap between chunks (default 0)" },
          unit: { type: "string", description: "chars (default) | tokens" },
          model: { type: "string", description: "tokenizer model when unit=tokens (default gpt-4o)" },
        },
        required: ["text"],
      },
      output: { example: { unit: "chars", size: 800, overlap: 100, count: 2, chunks: ["…", "…"] } },
    },
    handler: async (i) => {
      const text = cap(need(i, "text"));
      const unit = i.unit === "tokens" ? "tokens" : "chars";
      const size = clampInt(i.size, 800, 1, 100_000);
      const overlap = clampInt(i.overlap, 0, 0, size - 1);
      const step = size - overlap;
      const chunks = [];
      if (unit === "tokens") {
        const { enc, encoding } = await getEncoder(i.model || "gpt-4o");
        const toks = enc.encode(text);
        for (let s = 0; s < toks.length; s += step) chunks.push(enc.decode(toks.slice(s, s + size)));
        return { unit, size, overlap, model: i.model || "gpt-4o", encoding, count: chunks.length, chunks };
      }
      for (let s = 0; s < text.length; s += step) chunks.push(text.slice(s, s + size));
      return { unit, size, overlap, count: chunks.length, chunks };
    },
  },
  {
    route: "POST /api/json-validate", name: "JSON Schema validate", slug: "json-validate", category: "data", price: "$0.002",
    description:
      "Validate a JSON document against a JSON Schema (draft-07 subset) and get the list of violations. Supports type, required, properties, items, enum, const, min/max, length, pattern, format, anyOf/allOf/oneOf/not, additionalProperties. Deterministic — check an agent's structured output before you trust it.",
    tags: ["json-schema", "validate", "structured-output", "draft-07"],
    discovery: {
      bodyType: "json",
      input: { data: { name: "x", age: 3 }, schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } } } },
      inputSchema: { properties: { data: { description: "the JSON value to check (any type)" }, schema: { type: "object", description: "a JSON Schema (draft-07 subset)" } }, required: ["data", "schema"] },
      output: { example: { valid: true, errors: [] } },
    },
    handler: (i) => {
      if (!("data" in i)) throw bad('Missing "data"');
      // schema may arrive as an object (JSON body) or a JSON string (query); data
      // arrives already-parsed from the body and is used as-is (it can be any
      // JSON value, including a bare string we must not re-parse).
      const schema = parseMaybeJson(i.schema, "schema");
      if (typeof schema !== "object" || schema === null) throw bad('"schema" must be a JSON Schema object');
      const errors = [];
      validateNode(i.data, schema, "", errors);
      return { valid: errors.length === 0, errors };
    },
  },
  {
    route: "POST /api/jsonl", name: "JSONL convert", slug: "jsonl", category: "conversion", price: "$0.001",
    description:
      "Convert between a JSON array and JSONL/NDJSON (one JSON object per line). mode: to-jsonl (array → lines) or from-jsonl (lines → array). For streaming records to and from agents and datasets.",
    tags: ["jsonl", "ndjson", "json", "stream", "dataset"],
    discovery: {
      bodyType: "json",
      input: { data: [{ a: 1 }, { a: 2 }], mode: "to-jsonl" },
      inputSchema: { properties: { data: { description: "array (to-jsonl) or JSONL string (from-jsonl)" }, mode: { type: "string", description: "to-jsonl | from-jsonl" } }, required: ["data"] },
      output: { example: { mode: "to-jsonl", result: '{"a":1}\n{"a":2}', count: 2 } },
    },
    handler: (i) => {
      const mode = i.mode === "from-jsonl" ? "from-jsonl" : "to-jsonl";
      if (mode === "to-jsonl") {
        const arr = parseMaybeJson(i.data, "data");
        if (!Array.isArray(arr)) throw bad('"data" must be a JSON array for to-jsonl');
        return { mode, result: arr.map((x) => JSON.stringify(x)).join("\n"), count: arr.length };
      }
      const str = typeof i.data === "string" ? i.data : JSON.stringify(i.data);
      const lines = str.split(/\r?\n/).filter((l) => l.trim());
      const out = lines.map((l, idx) => {
        try { return JSON.parse(l); } catch (e) { throw bad(`line ${idx + 1} is not valid JSON: ${e.message}`); }
      });
      return { mode, result: out, count: out.length };
    },
  },
];
