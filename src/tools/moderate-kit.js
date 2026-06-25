// Moderation kit — x402-paywalled content moderation via OpenAI.
// Checks text for harmful content categories. Upstream cost is $0 (free API),
// so the $0.002 price is 100% margin. Env-gated: missing OPENAI_API_KEY → 503.

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MAX_TEXT_CHARS = 10_000;

function validateInput(input) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw bad('"text" is required — the content to check for policy violations');
  if (text.length > MAX_TEXT_CHARS) {
    throw bad(`Text too long (${text.length} chars). Maximum is ${MAX_TEXT_CHARS}`);
  }
  return { text };
}

async function callOpenAI(text) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
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

  const result = data.results?.[0];
  if (!result) throw bad("OpenAI returned no moderation result", 502);

  return {
    model: data.model || "omni-moderation-latest",
    flagged: result.flagged ?? false,
    categories: result.categories ?? {},
    category_scores: result.category_scores ?? {},
  };
}

export const MODERATE_TOOLS = [
  {
    route: "POST /api/moderate",
    name: "Content moderation",
    slug: "moderate",
    category: "ai",
    price: "$0.002",
    description:
      "Check text for harmful content using OpenAI moderation (omni-moderation-latest). Returns flagged status, category breakdown (harassment, hate, self-harm, sexual, violence, etc.), and confidence scores. No API key needed; pay per call via x402. Text capped at 10k chars.",
    tags: ["moderation", "safety", "content-filter", "ai", "openai", "trust-and-safety"],
    discovery: {
      bodyType: "json",
      input: { text: "This is a perfectly normal sentence about cooking pasta." },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to check for policy violations (max 10,000 chars)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "omni-moderation-latest",
          flagged: false,
          categories: {
            harassment: false,
            "harassment/threatening": false,
            hate: false,
            "hate/threatening": false,
            "self-harm": false,
            sexual: false,
            violence: false,
          },
          category_scores: {
            harassment: 0.00012,
            hate: 0.00003,
          },
        },
      },
    },
    handler: async (input) => {
      const { text } = validateInput(input);
      return callOpenAI(text);
    },
  },
];
