// The tool families whose runs can settle before their upstream work
// (src/settle-first.js). server.js arms a run only for a slug in
// settleFirstSlugs(); scripts/test-copy-absolutes.js reads the same lists, so a
// family added here is checked for the settle-first sentence in its
// descriptions without a second hand-kept list.
import { LLM_GATEWAY_TOOLS } from "./tools/llm-gateway-kit.js";
import { LLM_MESSAGES_TOOLS } from "./tools/llm-messages-kit.js";
import { LLM_GEMINI_TOOLS } from "./tools/llm-gemini-kit.js";
import { LLM_RESPONSES_TOOLS } from "./tools/llm-responses-kit.js";
import { IMAGES_FAST_TOOLS } from "./tools/llm-images-fast-kit.js";
import { DUB_TOOLS } from "./tools/dub-kit.js";
import { REDACT_CHAT_TOOLS } from "./tools/redact-chat-kit.js";
import { SEARCH_TOOLS } from "./tools/search.js";
import { IMAGE_GEN_TOOLS } from "./tools/image-gen-kit.js";
import { TTS_TOOLS } from "./tools/tts-kit.js";
import { STT_TOOLS } from "./tools/stt-kit.js";
import { JUDGE_TOOLS } from "./tools/judge-kit.js";

/** Catalog routes with a real upstream cost, each with its own settle point. */
export const SETTLE_FIRST_CATALOG_TOOLS = [...SEARCH_TOOLS, ...IMAGE_GEN_TOOLS, ...TTS_TOOLS, ...STT_TOOLS, ...JUDGE_TOOLS];
/** The image tiers that share the images handler (not the video route: its
 *  job is parked and resumed across calls), dub and redact-chat, behind the chat gateway's settle point. */
export const SETTLE_FIRST_SHARED_TOOLS = [...IMAGES_FAST_TOOLS.filter((t) => t.slug !== "v1-videos"), ...DUB_TOOLS, ...REDACT_CHAT_TOOLS];
/** Every /v1 model wire; server.js serves the enabled subset. */
export const SETTLE_FIRST_GATEWAY_TOOLS = [...LLM_GATEWAY_TOOLS, ...LLM_MESSAGES_TOOLS, ...LLM_GEMINI_TOOLS, ...LLM_RESPONSES_TOOLS];

/** The slugs that may settle first, given the /v1 wires this server serves. */
export function settleFirstSlugs(gatewayToolsEnabled) {
  return new Set([...gatewayToolsEnabled, ...SETTLE_FIRST_SHARED_TOOLS, ...SETTLE_FIRST_CATALOG_TOOLS].map((t) => t.slug));
}
