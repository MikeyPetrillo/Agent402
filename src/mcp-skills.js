// Skills over MCP (io.modelcontextprotocol/skills, SEP-2640) on the hosted
// connector. Each skill pack in src/skills.js is served as an Agent Skill: a
// SKILL.md resource at skill://agent402/<pack>/SKILL.md whose body names the
// one bundled call and the per-step tool calls the pack uses.
//
// The wire is JSON-RPC methods plus base Resources, so it is served on the
// installed v1 SDK by hand, the same way the tasks extension is:
//   - skills/list and skills/get are answered ahead of the SDK transport
//     (the installed SDK has no such methods);
//   - resources/list and resources/read run on the SDK's own schemas;
//   - the capability (`resources` plus `extensions["io.modelcontextprotocol/skills"]`)
//     is in the initialize answer only when the client declared the extension
//     there (or in the per-request client-capabilities _meta).
// The prompts path (prompts/list, prompts/get) is unchanged either way.
//
// Rollout switch: MCP_SKILLS=on (exactly "on"); off by default.
import { createHash } from "node:crypto";
import { SKILL_PACKS } from "./skills.js";
import { META_MCP_NAMES } from "./mcp-flagship.js";
import { CLIENT_CAPABILITIES_META } from "./mcp-tasks.js";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SKILL_METHODS = new Set(["skills/list", "skills/get"]);
export const isSkillMethod = (m) => SKILL_METHODS.has(String(m || ""));

// Every skill URI is under one prefix segment so a host that mounts several
// servers' skills sees whose they are from the URI alone.
export const SKILL_URI_PREFIX = "skill://agent402/";
export const skillUriOf = (slug) => `${SKILL_URI_PREFIX}${slug}/SKILL.md`;

// List-caching attributes the published extension asks for on list and get
// results. The content is fixed for a process lifetime (it changes only with
// a deploy), so a five-minute freshness hint is safe, and it is the same for
// every caller.
export const SKILLS_TTL_MS = 300000;
export const SKILLS_CACHE_SCOPE = "public";

const INVALID_PARAMS = -32602;

export function mcpSkillsEnabled() {
  return String(process.env.MCP_SKILLS || "").trim().toLowerCase() === "on";
}

/** True when the client declared the skills extension, at initialize
 *  (params.capabilities.extensions) or per request (the 2026-07-28 client
 *  capabilities _meta). */
export function clientDeclaresSkills(params) {
  const has = (ext) => Boolean(ext && typeof ext === "object" && !Array.isArray(ext) && Object.hasOwn(ext, SKILLS_EXTENSION));
  return has(params?.capabilities?.extensions) || has(params?._meta?.[CLIENT_CAPABILITIES_META]?.extensions);
}

// YAML frontmatter whose values are JSON strings. A JSON string is a valid
// YAML double-quoted scalar, so a host that parses the frontmatter reads back
// exactly the object published as `frontmatter` in the listing (the extension
// requires the two to be identical, field by field).
function yamlFrontmatter(fm) {
  return ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`), "---"].join("\n");
}

function skillBody(pack, { freeSlugs, priceOf }) {
  const call = META_MCP_NAMES.call_tool;
  const find = META_MCP_NAMES.find_tool;
  const bundled = `skill-${pack.slug}`;
  const bundledPrice = priceOf(bundled);
  const args = pack.promptArgs || [];
  const exampleParams = Object.fromEntries(args.filter((a) => a.substitute).map((a) => [a.name, a.substitute]));
  const lines = [`# ${pack.title}`, "", pack.useCase, ""];
  lines.push(`Every step below is a tool call on the MCP server that serves this skill.`, "");
  if (args.length) {
    lines.push("## Inputs", "");
    for (const a of args) {
      lines.push(`- \`${a.name}\` (${(a.required ?? true) ? "required" : "optional"}): ${a.description}${a.substitute ? `. Example: \`${a.substitute}\`` : ""}`);
    }
    lines.push("");
  }
  if (bundledPrice) {
    // The bundled route is free on this connector when it is in the connector's
    // own free set (isComputePayable, the gate's allowlist); the /skills page
    // words the same case as free with proof-of-work, or the price with a wallet.
    const runs = `runs all ${pack.toolSlugs.length} steps server-side and returns every step's result in one answer`;
    lines.push(
      "## Run it in one call",
      "",
      "```text",
      `${call} ${JSON.stringify({ slug: bundled, params: exampleParams })}`,
      "```",
      "",
      freeSlugs.has(bundled)
        ? `Free on this connector with proof-of-work (no wallet, no payment, rate-limited): one call ${runs}. With a wallet, the same call is ${bundledPrice} in USDC. A step that fails is reported in that answer without losing the others.`
        : `One payment of ${bundledPrice} ${runs}. A step that fails is reported in that answer without losing the others.`,
      "",
    );
  }
  lines.push(
    bundledPrice ? "## Run the steps yourself" : "## Steps",
    "",
    `Call each tool with ${call} { "slug": "<tool>", "params": { ... } }. ${find} { "task": "<tool>" } returns a tool's input schema and price.`,
    "",
  );
  if (pack.toolSlugs.length === pack.workflow.length) {
    pack.workflow.forEach((w, i) => lines.push(`${i + 1}. \`${pack.toolSlugs[i]}\`: ${w}`));
  } else {
    lines.push("Tools, in order:", "");
    pack.toolSlugs.forEach((s, i) => lines.push(`${i + 1}. \`${s}\``));
    lines.push("", "Workflow:", "");
    pack.workflow.forEach((w, i) => lines.push(`${i + 1}. ${w}`));
  }
  const free = pack.toolSlugs.filter((s) => freeSlugs.has(s));
  const paid = pack.toolSlugs.filter((s) => !freeSlugs.has(s));
  lines.push("", "## Access", "");
  if (free.length) lines.push(`- Free on this connector (proof-of-work, rate-limited): ${free.map((s) => `\`${s}\``).join(", ")}`);
  if (paid.length) lines.push(`- Paid per call (see ${META_MCP_NAMES.get_payment_info}): ${paid.map((s) => `\`${s}\``).join(", ")}`);
  lines.push("", "## Example request", "", ...String(pack.claudePrompt).split("\n").map((l) => `> ${l}`), "");
  return lines.join("\n");
}

const digestOf = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

/**
 * Builds the served skill set once per mount. `freeSlugs` is the connector's
 * free set; `priceOf(slug)` is the catalog price string or null (a bundled
 * route the catalog does not serve is not offered in the body).
 * Returns { entries, entryByUri, fileByUri }.
 */
export function buildSkillSet({ packs = SKILL_PACKS, freeSlugs = new Set(), priceOf = () => null } = {}) {
  const entries = [];
  const entryByUri = new Map();
  const fileByUri = new Map();
  for (const pack of packs) {
    const frontmatter = { name: pack.slug, description: pack.tagline };
    const text = `${yamlFrontmatter(frontmatter)}\n\n${skillBody(pack, { freeSlugs, priceOf })}`;
    const bytes = Buffer.from(text, "utf8");
    const uri = skillUriOf(pack.slug);
    const entry = { uri, frontmatter, resources: [{ uri, digest: digestOf(bytes), size: bytes.length }] };
    entries.push(entry);
    entryByUri.set(uri, entry);
    fileByUri.set(uri, { uri, name: pack.slug, title: pack.title, description: pack.tagline, mimeType: "text/markdown", text, size: bytes.length });
  }
  return { entries, entryByUri, fileByUri };
}

/** A JSON-RPC notification: a message with no `id` member. It gets no reply
 *  (the SDK transport answers a notification-only POST with an empty 202). */
export const isNotification = (body) => Boolean(body && typeof body === "object" && !Array.isArray(body) && !Object.hasOwn(body, "id"));

/** skills/list and skills/get. Returns a complete JSON-RPC response, or null
 *  for a notification, which JSON-RPC forbids answering (never throws). */
export function handleSkillsRpc(body, skillSet) {
  if (isNotification(body)) return null;
  const id = body?.id ?? null;
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const ok = (result) => ({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result, ttlMs: SKILLS_TTL_MS, cacheScope: SKILLS_CACHE_SCOPE } });
  // Absent params read as {}; params present but null (or any non-object) is refused.
  const params = body && Object.hasOwn(body, "params") ? body.params : {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) return err(INVALID_PARAMS, "params must be an object");
  if (body.method === "skills/list") {
    // One page holds every skill, so this server never issues a cursor and
    // any cursor it is handed is not one of its own.
    if (params.cursor != null) return err(INVALID_PARAMS, "Invalid cursor");
    return ok({ skills: skillSet.entries });
  }
  const uri = params.uri;
  if (typeof uri !== "string" || !uri) return err(INVALID_PARAMS, "uri is required and must be a string");
  const entry = skillSet.entryByUri.get(uri);
  if (!entry) return err(INVALID_PARAMS, `Unknown skill: ${uri.slice(0, 200)}. List skills with skills/list.`);
  return ok({ skill: entry });
}
