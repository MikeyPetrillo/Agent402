// Embeddings kit — two tiers of x402-paywalled text embeddings via OpenAI.
// Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   embed        $0.005  — text-embedding-3-small  (32k chars)
//   embed-large  $0.010  — text-embedding-3-large  (32k chars)

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const TIERS = {
  embed:         { model: "text-embedding-3-small", maxChars: 32_000 },
  "embed-large": { model: "text-embedding-3-large", maxChars: 32_000 },
};

function validateInput(input, tierSlug) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw bad('"text" is required — the text to embed');
  const cap = TIERS[tierSlug].maxChars;
  if (text.length > cap) {
    throw bad(`Text too long (${text.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }
  return { text };
}

async function callOpenAI(text, tierSlug) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const tier = TIERS[tierSlug];
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: tier.model, input: text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }

  const body = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("OpenAI upstream auth failed", 502);
    if (res.status === 429) throw bad("OpenAI rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error?.message || msg; } catch {}
    throw bad(`OpenAI error: ${msg}`, 502);
  }

  let data;
  try { data = JSON.parse(body); } catch { throw bad("OpenAI returned non-JSON", 502); }

  return {
    model: tier.model,
    provider: "openai",
    embedding: data.data?.[0]?.embedding ?? [],
    dimensions: data.data?.[0]?.embedding?.length ?? 0,
    usage: {
      total_tokens: data.usage?.total_tokens ?? 0,
    },
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { text } = validateInput(input, tierSlug);
    return callOpenAI(text, tierSlug);
  };
}

const SHARED_TAGS = ["embeddings", "vector", "rag", "semantic-search", "openai"];

export const EMBED_TOOLS = [
  {
    route: "POST /api/embed",
    name: "Text embeddings",
    slug: "embed",
    category: "ai",
    price: "$0.005",
    description:
      "Generate a text embedding vector using OpenAI text-embedding-3-small (1536 dimensions). Ideal for semantic search, RAG, and clustering. No API key needed; pay per call via x402. Text capped at 32k chars.",
    tags: [...SHARED_TAGS, "text-embedding-3-small"],
    discovery: {
      bodyType: "json",
      input: { text: "Agent402 is an open-source x402 tool server." },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to embed (max 32,000 chars)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "text-embedding-3-small",
          provider: "openai",
          embedding: [0.0023, -0.0091, 0.0152],
          dimensions: 1536,
          usage: { total_tokens: 12 },
        },
      },
    },
    handler: makeHandler("embed"),
  },
  {
    route: "POST /api/embed-large",
    name: "Text embeddings (Large)",
    slug: "embed-large",
    category: "ai",
    price: "$0.010",
    description:
      "Generate a text embedding vector using OpenAI text-embedding-3-large (3072 dimensions). Higher accuracy than the small model. Ideal for semantic search, RAG, and clustering. No API key needed; pay per call via x402. Text capped at 32k chars.",
    tags: [...SHARED_TAGS, "text-embedding-3-large", "large"],
    discovery: {
      bodyType: "json",
      input: { text: "Agent402 is an open-source x402 tool server." },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to embed (max 32,000 chars)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "text-embedding-3-large",
          provider: "openai",
          embedding: [0.0023, -0.0091, 0.0152],
          dimensions: 3072,
          usage: { total_tokens: 12 },
        },
      },
    },
    handler: makeHandler("embed-large"),
  },
];
