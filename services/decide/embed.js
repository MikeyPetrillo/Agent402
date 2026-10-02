// Embeddings for the decision index: the same upstream and model the public
// /v1/embeddings route serves (OpenAI text-embedding-3-small), at 512
// dimensions. Every call is time-bounded and batch-bounded, and a daily item
// ceiling stops a runaway re-embed (a row whose text changes every crawl) from
// becoming an open-ended bill.

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 512;
const URL_ = "https://api.openai.com/v1/embeddings";
const BATCH = 128;
const TIMEOUT_MS = 30_000;

const dailyMax = () => {
  const n = Number(process.env.DECIDE_EMBED_DAILY_MAX_ITEMS);
  return Number.isFinite(n) && n >= 0 ? n : 250_000;
};
let day = "", usedToday = 0;
function book(n) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; usedToday = 0; }
  if (usedToday + n > dailyMax()) return false;
  usedToday += n;
  return true;
}
export function embedBudgetStatus() { return { day, usedToday, max: dailyMax() }; }
export function _resetEmbedBudget() { day = ""; usedToday = 0; }

/** Embed texts; returns float arrays in order. Throws on failure or budget. */
export const embedApiKey = () => process.env.DECIDE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";

/** `meter` (optional array) receives { stage:"embed", items, tokens } per batch. */
export async function embedTexts(texts, { apiKey = embedApiKey(), fetchImpl = fetch, meter = null, stage = "embed" } = {}) {
  if (!apiKey) throw Object.assign(new Error("embeddings not configured"), { statusCode: 503 });
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map((t) => String(t).slice(0, 4000) || " ");
    if (!book(chunk.length)) throw Object.assign(new Error("daily embedding ceiling reached"), { statusCode: 503, code: "embed_ceiling" });
    const res = await fetchImpl(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: chunk, dimensions: EMBED_DIMS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw Object.assign(new Error(`embeddings upstream HTTP ${res.status}`), { statusCode: 502 });
    const j = await res.json();
    const rows = Array.isArray(j?.data) ? j.data.slice().sort((a, b) => a.index - b.index) : [];
    if (rows.length !== chunk.length) throw Object.assign(new Error("embeddings count mismatch"), { statusCode: 502 });
    meter?.push({ stage, model: EMBED_MODEL, items: chunk.length, tokens: Number(j?.usage?.total_tokens) || Number(j?.usage?.prompt_tokens) || 0 });
    for (const r of rows) out.push(r.embedding);
  }
  return out;
}
