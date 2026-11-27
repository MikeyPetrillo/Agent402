// Redact, then chat: mask PII in a text on this server, send only the masked
// text to a chat gateway tier, and answer with the model's reply.
//
// Two steps, both existing tools' code run in-process (the composition pattern
// dub-kit.js and pdf-summarize-kit.js use): the masking is `redact`'s own
// patterns (pii-redact.js, shared with that tool), numbered so each distinct
// value gets its own placeholder; the chat is the v1-chat gateway tier's
// handler, with its own default model, margin clamp, failover chain and settle
// point. The buyer pays this route's price once; the inner call is no second
// payment.
//
// ORDER. Every check on the caller's input, then the masking, then the size
// check on the masked messages, all before the chat handler is called; the
// chat handler's own settle point (fetchOpenRouter) comes after its checks. So
// a refused input reaches no settle call and no model, and the only text the
// chat step is ever handed is the masked one. The map from placeholder to
// original stays in this function's scope: it is read only to restore the
// answer when the caller asks (`restoreInAnswer`), and is never logged or
// answered.
//
// PRICE. The sum of the two tools it composes, read from their definitions at
// module load, never typed: `redact`'s list price plus the chat tier's.
//
// HONESTY. Masking is pattern-based and can miss PII written another way (a
// name, a street address, a number split oddly); the description says so and
// makes no wider claim.
import { KIT2 } from "./kit2.js";
import { LLM_GATEWAY_TOOLS, TIERS as GATEWAY_TIERS } from "./llm-gateway-kit.js";
import { SETTLE_FIRST_SENTENCE } from "../settle-first-copy.js";
import { redactText, newRedactionState, restorePlaceholders, PII_TYPES } from "./pii-redact.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const REDACT_CHAT_SLUG = "redact-chat";
export const CHAT_SLUG = "v1-chat";
const chatDef = LLM_GATEWAY_TOOLS.find((t) => t.slug === CHAT_SLUG);
if (!chatDef) throw new Error(`redact-chat-kit: ${CHAT_SLUG} missing from LLM_GATEWAY_TOOLS - was it renamed?`);
const redactDef = KIT2.find((t) => t.slug === "redact");
if (!redactDef) throw new Error("redact-chat-kit: redact missing from KIT2 - was it renamed?");

const priceUsdOf = (def) => Number(String(def.price).replace(/[^0-9.]/g, "")) || 0;
/** `redact`'s list price plus the chat tier's. */
export function redactChatPriceUsd() {
  return Math.round((priceUsdOf(redactDef) + priceUsdOf(chatDef)) * 1e6) / 1e6;
}
const priceLabel = () => `$${redactChatPriceUsd().toFixed(3)}`;

/** Caller input caps, checked before any masking or model call. */
export const TEXT_MAX_CHARS = 20_000;
export const INSTRUCTION_MAX_CHARS = 2_000;

/** The fixed framing the chat step is sent ahead of the caller's words. */
export const FRAMING =
  "The user's instruction and text below have had personal details replaced with placeholders such as [EMAIL_1], [PHONE_1], [CARD_1], [SSN_1] and [IP_1]." +
  " Follow the instruction on the text. When you refer to a redacted detail, write its placeholder exactly as it appears. Do not guess or invent what a placeholder stands for.";

/** The masked messages, as the chat step receives them. */
export function chatMessages(instruction, text) {
  return [
    { role: "system", content: FRAMING },
    { role: "user", content: `Instruction:\n${instruction}\n\nText:\n${text}` },
  ];
}

// The chat step. A test may replace it.
const steps = { chat: chatDef.handler };
export function __setChatForTest(fn) { steps.chat = fn || chatDef.handler; return steps; }

const truthy = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ""));

const stepError = (e) => {
  const inner = Number(e?.statusCode);
  // A throttle or an unavailable upstream keeps its status (the buyer should
  // wait); a 400 is the tier refusing the masked body (its own size bound);
  // anything else is answered as a bad upstream.
  const status = inner === 429 || inner === 503 || inner === 504 ? inner : inner === 400 ? 400 : 502;
  const msg = String(e?.message || e);
  // The tier's own size bound names that route's options (a model, "n"), which
  // this route does not take: say what this caller can change.
  const text = status === 400 && /too large/i.test(msg)
    ? "The masked instruction and text are too large for the chat step at this price; send a shorter text"
    : `Chat step failed: ${msg.slice(0, 300)}`;
  return Object.assign(bad(text, status), { step: "chat", cause: e });
};

function stringField(input, name, max, required) {
  const v = input?.[name];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw bad(`"${name}" is required: a non-empty string`);
    return "";
  }
  if (typeof v !== "string") throw bad(`"${name}" must be a string`);
  if (v.length > max) throw bad(`"${name}" is too long (${v.length} chars); the most is ${max}`);
  return v;
}

async function redactChat(input) {
  const text = stringField(input, "text", TEXT_MAX_CHARS, true);
  const instruction = stringField(input, "instruction", INSTRUCTION_MAX_CHARS, true);
  const restore = truthy(input?.restoreInAnswer);
  const showRedacted = truthy(input?.includeRedactedInput);

  // Mask both fields with one numbering, so a value in both gets one placeholder.
  const state = newRedactionState([instruction, text]);
  const maskedInstruction = redactText(instruction, { numbered: true, state });
  const maskedText = redactText(text, { numbered: true, state });
  const entries = state.entries;
  const counts = {};
  for (const type of PII_TYPES) {
    const n = (maskedInstruction.counts[type] || 0) + (maskedText.counts[type] || 0);
    if (n) counts[type] = n;
  }

  const messages = chatMessages(maskedInstruction.text, maskedText.text);
  const size = messages.reduce((n, m) => n + m.content.length, 0);
  const tierMax = GATEWAY_TIERS[CHAT_SLUG].maxInputChars;
  if (size > tierMax) throw bad(`The masked instruction and text come to ${size} chars with the framing, over the chat tier's ${tierMax}; send a shorter text`);

  let completion;
  try { completion = await steps.chat({ messages }); }
  catch (e) { throw stepError(e); }
  const choice = completion?.choices?.[0];
  const content = choice?.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
  if (!raw.trim()) throw stepError(bad("the model returned no answer", 502));

  const out = {
    answer: raw,
    redactions: entries.map(({ type, placeholder }) => ({ type, placeholder })),
    counts,
    modelTier: CHAT_SLUG,
    model: completion?.model || null,
    finishReason: choice?.finish_reason || null,
  };
  if (restore) {
    const r = restorePlaceholders(raw, entries);
    out.answer = r.text;
    out.restored = r.restored;
  }
  if (showRedacted) out.redactedInput = { instruction: maskedInstruction.text, text: maskedText.text };
  return out;
}

const chatPath = chatDef.route.split(" ")[1];
export const REDACT_CHAT_TOOLS = [
  {
    route: "POST /api/redact-chat",
    name: "Redact, then chat",
    slug: REDACT_CHAT_SLUG,
    aliases: ["redacted-chat"],
    category: "ai",
    price: priceLabel(),
    modelBacked: true,
    description:
      `Mask personal details in a text on this server, then send only the masked text to a chat model, in one paid call. Email addresses, card-like runs of 13 to 16 digits, US SSNs written 123-45-6789, US-style phone numbers (ten digits, with an optional short country prefix) and IPv4 addresses are replaced with numbered placeholders ([EMAIL_1], [PHONE_1]) by the same pattern matching as /api/redact, before the model call; the model receives the masked instruction and text, not the values that were masked. Pattern matching can miss details written in other forms: international phone numbers, SSNs without dashes, IPv6 addresses, longer card or account numbers such as IBANs, names and street addresses pass unmasked, so review the text for anything else sensitive. restoreInAnswer: true puts the originals back into the answer on this server after the model replies. includeRedactedInput: true also returns the masked text that was sent. The chat runs on the ${chatPath} gateway tier with its default model; the price is the sum of /api/redact and that tier. Text up to ${TEXT_MAX_CHARS} chars and instruction up to ${INSTRUCTION_MAX_CHARS}, checked before any model call. A failed chat step answers an error and is not charged on x402, card and credits. ${SETTLE_FIRST_SENTENCE} Model-backed.`,
    pageSummary:
      `Masks personal details in a text on this server, sends only the masked text to a chat model and returns its answer. Email addresses, card-like runs of 13 to 16 digits, US SSNs written 123-45-6789, US-style phone numbers and IPv4 addresses become placeholders ([EMAIL_1]); the model receives the masked text, not the values that were masked. Pattern matching can miss other forms: international phone numbers, SSNs without dashes, IPv6 addresses, IBANs, names and street addresses pass unmasked. Text up to ${TEXT_MAX_CHARS} chars, instruction up to ${INSTRUCTION_MAX_CHARS}. A failed chat step is not charged on x402, card and credits. ${SETTLE_FIRST_SENTENCE} Model-backed.`,
    tags: ["pii", "privacy", "mask", "llm"],
    discovery: {
      bodyType: "json",
      input: {
        instruction: "Write a short, polite reply confirming the new meeting time.",
        text: "Hi, this is ada@example.com (555-123-4567). Can we move our call to Friday at 2pm?",
        restoreInAnswer: true,
      },
      inputSchema: {
        properties: {
          text: { type: "string", maxLength: TEXT_MAX_CHARS, description: `The text to work on (max ${TEXT_MAX_CHARS} chars); masked before the model sees it` },
          instruction: { type: "string", maxLength: INSTRUCTION_MAX_CHARS, description: `What the model should do with the text (max ${INSTRUCTION_MAX_CHARS} chars); masked the same way` },
          restoreInAnswer: { type: "boolean", description: "true puts the original values back into the answer on this server (default false: the answer keeps the placeholders)" },
          includeRedactedInput: { type: "boolean", description: "true also returns the masked instruction and text that were sent to the model (default false)" },
        },
        required: ["text", "instruction"],
      },
      output: {
        example: {
          answer: "Hi Ada, Friday at 2pm works. I will send the updated invite to ada@example.com. Thanks!",
          redactions: [{ type: "email", placeholder: "[EMAIL_1]" }, { type: "phone", placeholder: "[PHONE_1]" }],
          counts: { email: 1, phone: 1 },
          modelTier: CHAT_SLUG,
          model: GATEWAY_TIERS[CHAT_SLUG].defaultModel,
          finishReason: "stop",
          restored: 1,
        },
        optional: ["restored", "redactedInput"],
      },
    },
    handler: redactChat,
  },
];
