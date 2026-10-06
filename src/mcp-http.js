import { RAILS_PAREN, RAILS_OR } from "./rails.js";
// The report/monitor ladder, DERIVED from the same tables that sell them.
// No cycle: report-tiers is a leaf over the kit tier tables, and neither
// checkout module imports this one.
import { reportLadderProse, agentReportPriceRange } from "./report-tiers.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
let _ladder = null;
const reportLadder = () => (_ladder ||= reportLadderProse({ humanProducts: HUMAN_PRODUCTS, monitorProducts: MONITOR_PRODUCTS }));
// Remote MCP endpoint (Streamable HTTP) — makes Agent402 an installable
// connector: paste https://agent402.tools/mcp into Claude (Settings >
// Connectors), ChatGPT, or any MCP client that speaks streamable HTTP.
//
// This is the authless free tier. It runs in the same process as the tools and
// lists a FLAGSHIP set (search/answer front door + render/data/STT/memory) plus
// meta discovery tools. Pure-CPU tools still execute free via call_tool /
// find_tool; wallet-only flagships return paid-access setup pointing at the
// npm `agent402-mcp` server with a funded AGENT_KEY. Payment identity can't
// flow through a hosted authless connector, so paid execution stays on the
// stdio package by design.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_PAYMENT_REQUIRED_CODE, MCP_PAYMENT_VERIFICATION_FAILED_CODE, MCP_RECEIPT_META, MCP_PAYMENT_REQUIRED_META, credentialHeaderFromMeta, challengesFromHeader, receiptFromHeader, challengeIdFromMeta,
} from "./mcp-mpp.js";
import {
  TASKS_EXTENSION, TASK_INVALID_PARAMS, TASK_MISSING_CAPABILITY, TASK_INTERNAL_ERROR,
  mcpTasksEnabled, clientDeclaresTasks, createTaskStore, createTaskResult, detailedTask, taskAck, isTaskMethod,
} from "./mcp-tasks.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "./composite-spend-guard.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { mppFlagshipRows, mppFlagshipOffersPhrase } from "./mpp-flagship.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { findTools, findRelatedSellers, applyFrontDoorTerms } from "./find.js";
import { buildPlanSketch } from "./plan-sketch.js";
import { partialFields, clampFields } from "./partial-answer.js";
import { routableSellerSummaries } from "./x402-index.js";
import { logSafe } from "./log-safe.js";
import { withoutPaymentRequired } from "./payment-required-body.js";
import { recordWish } from "./wish.js";
import { capturePostHogDiscovery } from "./posthog.js";
import { rankBy as rankLeaderboard } from "./leaderboard.js";
import { SKILL_PACKS, PACK_PRICE_RANGE, buildPromptMessages, rankSkillPacks } from "./skills.js";
import {
  FLAGSHIP_SLUGS,
  FLAGSHIP_MCP_NAMES,
  META_MCP_NAMES,
  MCP_CALL_ALIASES,
  resolveListedName,
  FLAGSHIP_OPEN_WORLD,
  FLAGSHIP_WRITERS,
  FLAGSHIP_OUTPUT_SCHEMAS,
  META_OUTPUT_SCHEMAS,
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_WEBSITE,
  mcpInstallHints,
  mcpInitializeInstructions,
  mcpJsonResult,
  outputSchemaFromExample,
} from "./mcp-flagship.js";
import {
  createLimiter,
  MAX_CALLS_PER_BURST,
  MAX_CALLS_PER_WINDOW,
} from "./rate-limit.js";

// The connector is the server, so it reports the server's build rather than
// a hand-typed number ("0.3.0" sat here unchanged from 2026-06-12 to
// 2026-09-22 beside the stdio package's 0.13.x on the same serverInfo text).
const VERSION = `build-${(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev").slice(0, 7)}`;

// Mirrors server.js's FIND_WEAK_SCORE: an empty result set, or a top score
// below this, reads as "the catalog probably doesn't have this" — the
// trigger for the request_tool hint + a fire-and-forget find-miss wish.
// 3, not 5: a tag or slug-substring match is a SERVED query (see server.js -
// the old 5 recorded a wish for every tag-served query, a ghost cluster).
const FIND_WEAK_SCORE = 3;
const WISH_HINT_TEXT = "Nothing matched well? Tell us what you needed via POST /api/wish - we cluster demand and build what keeps coming up.";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure. Limiter implementation +
// policy live in src/rate-limit.js so the direct-HTTP PoW redemption path
// applies the same quota.
const mcpLimiter = createLimiter("mcp");
const rateLimited = (ip) => mcpLimiter.check(ip).limited;

// Outer transport guards (audit R-11). The tool limiter above only fires INSIDE
// call_tool; a flood of initialize/discovery/malformed POSTs would otherwise
// allocate a server + transport per request before any tool limit applies.
// These bound raw POST volume BEFORE server creation:
//   - a per-IP request cap on its OWN bucket, deliberately more generous than
//     the tool limiter so a legit session (one initialize + many tool calls)
//     is never throttled by it;
//   - a global in-flight transport semaphore capping concurrent allocation;
//   - a per-request deadline so a stalled request can't pin a transport.
// All env-tunable; defaults are generous for real clients, tight against floods.
const MCP_REQ_PER_MIN = Number(process.env.AGENT402_MCP_REQ_PER_MIN) || Math.max(60, MAX_CALLS_PER_BURST * 3);
const MCP_REQ_PER_HOUR = Number(process.env.AGENT402_MCP_REQ_PER_HOUR) || Math.max(600, MAX_CALLS_PER_WINDOW * 3);
const mcpReqLimiter = createLimiter("mcp-transport", { perMin: MCP_REQ_PER_MIN, perHour: MCP_REQ_PER_HOUR });
const MCP_MAX_CONCURRENT = Number(process.env.AGENT402_MCP_MAX_CONCURRENT) || 64;
const MCP_REQ_DEADLINE_MS = Number(process.env.AGENT402_MCP_REQ_DEADLINE_MS) || 30_000;
// After the deadline fires (or the client disconnects) we abort + close the
// transport, then wait up to this long for the underlying handler to actually
// terminate before releasing its in-flight slot (audit F14). Bounds a wedged
// handler so it can't hold a slot forever.
const MCP_DRAIN_MS = Number(process.env.AGENT402_MCP_DRAIN_MS) || 5_000;
// A blocking paid call's loopback ends this long before the request deadline,
// so the tool result (not a transport error) is what the caller sees.
const PAID_LOOPBACK_TIMEOUT_MS = Math.max(1_000, MCP_REQ_DEADLINE_MS - 2_500);
// What a caller is told when a PAID call was cut off on this connector. When
// the connector stops waiting it closes its loopback request, and a paid
// request whose connection closes before the first response byte is not
// settled while it holds a hang-up forgiveness ticket
// (src/hangup-settlement.js); a handler that had not started never runs.
// Without a ticket (the budget is spent), or for a close that lands while
// the settle call itself is in flight, the charge goes through and is
// recorded as owed and refunded. The connector cannot tell which happened at
// the moment it gives up, so "not charged" would not be a promise it can keep.
export const PAID_CUTOFF_TEXT = "The call may still have completed and been charged. If it was, the charge is recorded as owed in our refund ledger and repaid after review. Check any payment by its settlement transaction, free, at GET /api/refunds/lookup?tx=<hash>: it answers whether a refund is recorded and, once sent, our refund transaction. Do not retry blindly: a retry is a new paid call.";
export const UNPAID_CUTOFF_TEXT = "No payment was presented, so nothing was charged.";
// The RFC 9457 members of a 402 problem document, and nothing else. A paywall
// 402 body also carries the full PaymentRequired offer (it mirrors the
// PAYMENT-REQUIRED header, src/payment-required-body.js); the error data, the
// soft-ask _meta and a task record carry the problem only, and the offer
// reaches an MPP client through the challenges beside it. A plain unpaid 402
// has no `type`, so it is not a problem document.
const PROBLEM_MEMBERS = Object.freeze(["type", "title", "status", "detail", "hint", "details", "instance"]);
export function problemOf(j) {
  if (!j || typeof j !== "object" || Array.isArray(j) || typeof j.type !== "string") return undefined;
  const out = {};
  for (const k of PROBLEM_MEMBERS) if (j[k] !== undefined) out[k] = j[k];
  return out;
}

/** The tool-result text for a call this connector stopped waiting on.
 *  `paid` = a payment credential rode along on the call; only without one is
 *  "nothing was charged" certain. */
export function connectorCutoffText({ label, seconds, paid, route = null, error = null }) {
  const money = paid ? PAID_CUTOFF_TEXT : UNPAID_CUTOFF_TEXT;
  const where = route ? `${route} over HTTP` : "the tool's HTTP route directly";
  if (error != null) return `${label}: the call could not be completed (${String(error).slice(0, 120)}). ${money}${paid ? "" : " Retry shortly."}`;
  return `${label}: the call did not finish within ${seconds}s on this connector and the connector stopped waiting. ${money} ${paid ? "For long calls, use" : "Retry, or call"} ${where}, which has no connector deadline.`;
}
// How long a task-eligible composite may run before we answer with a task
// handle instead of blocking. Sized well under MCP_REQ_DEADLINE_MS so the
// synchronous answer always fits, and well over the time a paywall needs to
// decide a 402 (which is settled before the handler runs).
const TASK_GATE_MS = Number(process.env.AGENT402_MCP_TASK_GATE_MS) || 8_000;
let mcpInFlight = 0;

/**
 * Mount the MCP endpoint on the express app.
 * `catalog` is the CATALOG map (route -> tool def), `opts.isComputePayable`
 * decides the free set. `opts.onServed(slug, { latencyMs, errored })` feeds
 * both the stats counters and the analytics dashboard with full per-call meta.
 */
// `path` + `profile` (2026-09-10): a SECOND mount of the same connector at
// another path, serving ONE product. `profile = { serverName, instructions,
// flagshipSlugs, mcpNames, metaTools:false }` lists only those tools (with
// payment.info and server.describe), hides the catalog meta tools, and names
// the server; the catalog passed in is already filtered to the product. Built
// for directory listings whose bar is "one hosted MCP URL, one job, unpaid
// calls 402" and which refuse the full catalog as a tool dump.
let sharedTaskStore = null;
/** Test seam: how many task stores this process holds (must be at most one). */
export function _sharedTaskStoreForTest() { return sharedTaskStore; }
/** The MPP methods the hosted connector can settle a paid tool call with. */
export function mcpPaymentMethods() {
  return {
    evm: { intents: ["charge"] },
    ...(tempoEnabled() ? { tempo: { intents: ["charge"] } } : {}),
    ...(stripeEnabled() ? { stripe: { intents: ["charge"] } } : {}),
  };
}

export function mountMcp(app, catalog, { baseUrl, isComputePayable, onServed = () => {}, getLeaderboard = null, getMppLeaderboard = null, mppLoopback = null, decideFeedback = null, taskStore = null, taskStoreDir = null, path = "/mcp", profile = null }) {
  const scoped = profile?.metaTools === false;
  const HIDDEN_WHEN_SCOPED = new Set([META_MCP_NAMES.search_tools, META_MCP_NAMES.find_tool, META_MCP_NAMES.call_tool, META_MCP_NAMES.request_tool, META_MCP_NAMES.list_top_sellers]);
  const listable = (arr) => (scoped ? arr.filter((t) => !HIDDEN_WHEN_SCOPED.has(t.name)) : arr);
  // Live per-tool prices for the skill-pack a la carte comparison. Built once
  // from the same catalog this connector serves, so the number an agent sees
  // next to a pack is the price it would actually pay for the steps.
  const packPriceIndex = new Map();
  for (const def of Object.values(catalog)) {
    const n = Number(String(def?.price ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && def?.slug) packPriceIndex.set(String(def.slug).toLowerCase(), n);
  }
  const toolPriceUsd = (slug) => packPriceIndex.get(String(slug).toLowerCase()) ?? null;
  // MPP start-here set (src/mpp-flagship.js) as served by this connector's
  // catalog, prices read from it. Surfaced in payment.info.
  const mppStartHere = mppFlagshipRows(catalog).map((r) => ({ slug: r.slug, method: r.method, path: r.path, url: `${baseUrl}${r.path}`, price: r.price, why: r.why }));
  const tools = new Map(); // slug -> { def, free }
  for (const def of Object.values(catalog)) {
    tools.set(def.slug, { def, free: isComputePayable(def) });
  }
  const freeCount = [...tools.values()].filter((t) => t.free).length;
  const freeSlugs = new Set([...tools.entries()].filter(([, t]) => t.free).map(([slug]) => slug));
  const mcpClients = new Map(); // "name@version" -> initialize count since boot

  // MCP Tasks (io.modelcontextprotocol/tasks). Armed only when tasks are enabled
  // AND the MPP loopback exists: the whole point is selling the long-running
  // composites, every one of which is wallet-only, so with no paid path there is
  // nothing a task could carry. Construction runs the boot sweep, which resolves
  // any run orphaned by the previous process BEFORE the first tasks/get.
  // ONE store per process, whatever the mount count (security review
  // 2026-09-10): a second mount (/mcp/sec) built its own store over the same
  // directory, so records were shared through disk but the in-memory `runs`
  // map (the AbortControllers) was not - a tasks/cancel on the other path
  // wrote "cancelled" without aborting the loopback, the run settled anyway,
  // and the delivered 200 was discarded as a "you were not charged" cancel.
  const tasks = mcpTasksEnabled() && mppLoopback
    ? (taskStore || (sharedTaskStore ??= createTaskStore({
      dir: taskStoreDir,
      // A settled 200 whose result we could not retain is the one charged-but-
      // undelivered case this path can produce. The refund ledger demands
      // POSITIVE proof of a charge, so an unreadable receipt records nothing.
      onChargedFailure: async ({ slug, receipt, priceUsd }) => {
        try {
          const { recordRefundOwed, receiptProvesCharge } = await import("./refund-ledger.js");
          if (!receiptProvesCharge(receipt)) return;
          recordRefundOwed({
            slug,
            network: receipt?.network ?? null,
            payer: receipt?.payer ?? receipt?.from ?? null,
            priceUsd,
            tx: receipt?.transaction ?? receipt?.tx ?? null,
            httpStatus: 500,
          });
        } catch { /* recording a debt must never break the serving path */ }
      },
    })))
    : null;

  // Flagship first-class tools: demand SKUs agents should see without a
  // find_tool round-trip (search/answer front door + render/data/STT/memory).
  // Most are wallet-only on this authless connector — calling one returns
  // paid-access setup (same as call_tool on a wallet slug). The long catalog
  // stays behind search_tools / find_tool / call_tool. Total tools/list size
  // stays in Glama's ~3–15 well-scoped band: meta tools + these flagships.
  // Keep FLAGSHIP_SLUGS in sync with mcp/index.js DEFAULT_CURATED.
  const flagshipSet = new Set();
  for (const slug of (profile?.flagshipSlugs || FLAGSHIP_SLUGS)) {
    if (tools.has(slug)) flagshipSet.add(slug);
  }

  const schemaOf = (def) => {
    const s = def.discovery?.inputSchema;
    return s ? { type: "object", ...s } : { type: "object" };
  };

  // Listed MCP names use Smithery dot-notation (domain.action). CallTool also
  // accepts prior snake/digit aliases via resolveListedName + this map.
  const toSnake = (slug) => String(slug).replace(/-/g, "_");
  const NAMES = { ...FLAGSHIP_MCP_NAMES, ...(profile?.mcpNames || {}) };
  const mcpNameOf = (slug) => NAMES[slug] || toSnake(slug);
  // Prior free-utility MCP names still route so older clients do not hard-break
  // after the flagship swap (they are no longer listed in tools/list).
  const LEGACY_MCP_ALIASES = {
    generate_hash: "hash", convert_units: "unit-convert", generate_qr: "qr",
    format_json: "json-format", decode_jwt: "jwt-decode", convert_base64: "base64",
    generate_uuid: "uuid", parse_csv: "csv-to-json", convert_timezone: "timezone-convert",
    get_wallet_balances: "wallet-balances", get_wallet_transactions: "wallet-transactions",
    base64_convert: "base64", qr_generate: "qr", uuid_generate: "uuid", hash_generate: "hash",
  };
  // Every accepted spelling of a first-class tool name -> its catalog slug
  // (dotted name, prior snake aliases, plain snake form, raw kebab slug).
  const namedToolSlugs = new Map();
  const dottedToSlug = Object.fromEntries(
    Object.entries(NAMES).map(([slug, dotted]) => [dotted, slug])
  );
  for (const slug of flagshipSet) {
    namedToolSlugs.set(mcpNameOf(slug), slug);
    namedToolSlugs.set(toSnake(slug), slug);
    namedToolSlugs.set(slug, slug);
  }
  for (const [alias, canonical] of Object.entries(MCP_CALL_ALIASES)) {
    const slug = dottedToSlug[canonical];
    if (slug && flagshipSet.has(slug)) namedToolSlugs.set(alias, slug);
  }
  for (const [alias, slug] of Object.entries(LEGACY_MCP_ALIASES)) {
    if (tools.has(slug)) {
      namedToolSlugs.set(alias, slug);
      // Also accept the raw kebab / snake slug so older CallTool clients that
      // still send "base64" / "hash" (not listed anymore) keep working.
      namedToolSlugs.set(slug, slug);
      namedToolSlugs.set(toSnake(slug), slug);
    }
  }
  // A concise "Returns { … }" clause from a tool's documented example so every
  // flagship tool advertises its output shape, not just its input.
  const returnsHint = (def) => {
    const ex = def.discovery?.output?.example;
    if (!ex || typeof ex !== "object") return "";
    const keys = Object.keys(ex).slice(0, 8);
    return keys.length ? ` Returns { ${keys.join(", ")} }.` : "";
  };

  // Most rows one catalog.search answer carries. A ranking, so a ceiling is
  // right; publishing it beside the rows is what stops the ceiling being read
  // as the match count.
  const SEARCH_LIMIT_MAX = 25;

  // Returns { rows, topScore, matched } — topScore feeds the "did this actually
  // match anything useful" check for the request_tool hint (see search_tools
  // below), and `matched` is how many tools scored at all, which is the number
  // the answer was silently withholding.
  function searchTools(query, limit = 10) {
    const q = String(query || "");
    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    applyFrontDoorTerms(terms, q);
    const scored = [];
    for (const { def, free } of tools.values()) {
      const slug = def.slug.toLowerCase();
      const tagSet = new Set((def.tags || []).map((tg) => String(tg).toLowerCase()));
      const hay = `${def.name} ${def.description} ${def.category} ${(def.tags || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (slug === term) score += 10;
        if (slug.includes(term)) score += 4;
        if (tagSet.has(term)) score += 3;
        if (hay.includes(term)) score += 1;
      }
      if (score > 0) scored.push([score, def, free]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const rows = scored.slice(0, Math.min(Number(limit) || 10, SEARCH_LIMIT_MAX)).map(([, def, free]) => ({
      slug: def.slug,
      price: def.price,
      access: free ? "free here (rate-limited)" : "paid (USDC via x402 / MPP - agent402-mcp with AGENT_KEY, or a prepaid credits key already issued as AGENT402_CREDITS_KEY)",
      description: def.description.length > 200 ? `${def.description.slice(0, 200)}…` : def.description,
      inputSchema: schemaOf(def),
    }));
    return { rows, topScore: scored[0]?.[0] ?? 0, matched: scored.length };
  }

  function walletRequiredText(def) {
    return [
      `"${def.slug}" (${def.price}/call) needs per-call payment and is not part of this hosted free tier.`,
      ...(mppLoopback ? [`Pay it RIGHT HERE over MPP: call again with an MPP credential in _meta["org.paymentauth/credential"] - mppx's McpClient.wrap() does this automatically (USDC on Base/Celo via evm.charge, or native Tempo via tempo.charge); the receipt comes back in _meta["org.paymentauth/receipt"].`] : []),
      `Or from Claude/any MCP client: run the npm server with a funded Base wallet -`,
      `npx agent402-mcp with env AGENT_KEY=0x<private key> (USDC on Base/Polygon/Arbitrum, or USDG on Robinhood Chain via AGENT402_NETWORKS=robinhood) and/or SOLANA_AGENT_KEY=<base58 secret> (USDC on Solana); spend caps: AGENT402_MAX_PER_CALL, AGENT402_BUDGET.`,
      `Already hold a prepaid credits key? Run npx agent402-mcp with AGENT402_CREDITS_KEY=a402_... (or send Authorization: Bearer a402_... over HTTP); new credits are not on sale. Or call it over HTTP with any x402 client. Docs: ${baseUrl}/tools/${def.slug}`,
    ].join(" ");
  }

  function buildServer(ip, signal, heartbeatToken = null) {
    const server = new Server(
      {
        name: profile?.serverName || "agent402",
        version: VERSION,
        title: "Agent402",
        description: MCP_SERVER_DESCRIPTION,
        websiteUrl: baseUrl || MCP_SERVER_WEBSITE,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          // MCP Tasks extension (io.modelcontextprotocol/tasks). The 2026-07-28
          // spec has servers advertise extensions in the capabilities returned
          // by `server/discover`; this connector still speaks the initialize
          // handshake, so the same capabilities object is where it goes. Only
          // advertised when the extension is armed AND paid calls are actually
          // possible here - a task only exists to carry a PAID composite run.
          ...(tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
          // MPP transport-mcp "MCP Capability Advertisement": the methods a
          // paid tool call here can be settled with, read from the gates that
          // are actually live. Only when the MPP loopback exists - without it a
          // paid call here cannot be settled at all.
          ...(mppLoopback ? { experimental: { payment: { methods: mcpPaymentMethods() } } } : {}),
        },
        instructions: profile?.instructions || mcpInitializeInstructions(baseUrl, { decide: !!catalog["POST /api/decide"] }),
      },
    );

    // Skill packs are exposed as MCP prompts: each pack becomes a discoverable
    // prompt the client can render in a slash menu (Claude Desktop, Cursor,
    // etc.). The pack data lives in src/skills.js — same source of truth as
    // the HTML pages at /skills/<slug>. buildPromptMessages does the args
    // substitution + tool-plan rendering, and gets freeSlugs so it can pre-
    // split free vs wallet-only tools for the caller.
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: SKILL_PACKS.map((p) => ({
        name: p.slug,
        title: p.title,
        description: p.tagline,
        arguments: (p.promptArgs || []).map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required ?? true,
        })),
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      const pack = SKILL_PACKS.find((p) => p.slug === name);
      if (!pack) throw new Error(`Unknown prompt "${name}". List available with prompts/list.`);
      return buildPromptMessages(pack, args, { freeSlugs });
    });

    // Titles + safety annotations on every tool are required for listing in
    // Anthropic's connector directory. Meta discovery tools are honestly
    // read-only; flagship egress tools set openWorldHint; memory-write writes.
    const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listable([
        {
          name: META_MCP_NAMES.search_tools,
          title: "Search the Agent402 tool catalog",
          annotations: { title: "Search the Agent402 tool catalog", ...SAFE },
          description:
            `BROWSE the long catalog behind the flagship set: keyword search over Agent402's 500+ pay-per-call tools (exact count ${tools.size}). Start with the listed flagships for search/answer/news/render/data/transcribe/memory; use this when you need a long-tail slug. Counterpart catalog.find resolves a task to ONE ready-to-run pick - search explores, find decides. ${freeCount} pure-CPU tools run free here (proof-of-work); the rest are payable right here over MPP (credential in _meta - mppx McpClient pays automatically) or via npx agent402-mcp with a wallet. Also an OpenAI-compatible LLM gateway at ${baseUrl}/v1 (flat per-call; wallet = account). Returns { results, workflows }; run one with catalog.call.`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: 'What you need, e.g. "search the web for x402", "answer a question with citations", "decode JWT"' },
              limit: { type: "number", description: "Max results (default 10)" },
            },
            required: ["query"],
          },
          outputSchema: META_OUTPUT_SCHEMAS["catalog.search"],
        },
        {
          name: META_MCP_NAMES.find_tool,
          title: "Resolve a task to the one best Agent402 tool",
          annotations: { title: "Resolve a task to the one best Agent402 tool", ...SAFE },
          description:
            "DECIDE, don't browse: resolve a plain-language task to the single best-matching Agent402 tool, returned call-ready - slug, price, input schema, and a worked example (its counterpart catalog.search returns a list of candidates to compare - search explores, find decides). Prefer this for anything outside the flagship list. Returns { task, results } with the top pick first; then run catalog.call with the chosen slug + params.",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string", description: 'What you want to do, e.g. "search the web for x402 adoption" or "convert miles to km"' },
              limit: { type: "number", description: "Max results (default 5)" },
            },
            required: ["task"],
          },
          outputSchema: META_OUTPUT_SCHEMAS["catalog.find"],
        },
        {
          name: META_MCP_NAMES.call_tool,
          title: "Run an Agent402 tool",
          annotations: { title: "Run an Agent402 tool", ...SAFE },
          description:
            `Run an Agent402 tool by slug (discover slugs with catalog.find or catalog.search; params must match that tool's inputSchema). The ${freeCount} pure-CPU tools execute free on this hosted connector (rate-limited, no wallet - proof-of-work covers them) and return the tool's JSON result. Wallet-only tools (live search/answer, browser render, market data, STT, durable memory) ${mppLoopback ? "answer with a payment ask that is payable right here over MPP (the challenges ride in _meta[\"org.paymentauth/payment-required\"], and the text names every other way to pay)" : "return a paid-access setup guide instead"} - this connector holds no wallet of its own. An unknown slug returns an error pointing back to catalog.search.`,
          inputSchema: {
            type: "object",
            properties: {
              slug: { type: "string", description: 'Tool slug, e.g. "search" or "unit-convert"' },
              params: { type: "object", description: "Tool input, matching the tool's inputSchema" },
            },
            required: ["slug"],
          },
          outputSchema: META_OUTPUT_SCHEMAS["catalog.call"],
        },
        {
          name: META_MCP_NAMES.get_payment_info,
          title: "Payment and wallet setup",
          annotations: { title: "Payment and wallet setup", ...SAFE },
          description:
            `How paying for Agent402 tools works and how to manage a wallet. This hosted connector holds NO wallet: ${freeCount} pure-CPU tools run free here (or solve a proof-of-work puzzle), the rest - including search/answer and the /v1 OpenAI-compatible LLM gateway - settle in USDC via x402. Covers: the free vs paid split, how to configure a funded wallet + per-call and budget spend caps, the rails (${RAILS_OR}), and checking a wallet's balance/transaction history via catalog.call on wallet-balances / wallet-transactions. Returns { connector, freeTier, pay, spendControls, balanceAndHistory }.`,
          inputSchema: { type: "object", properties: {} },
          outputSchema: META_OUTPUT_SCHEMAS["payment.info"],
        },
        // Flagship demand tools — listed first-class so agents see search/answer
        // as the front door without a discovery round-trip. Wallet-only on this
        // authless connector: calling returns paid-access setup.
        ...[...flagshipSet].map((slug) => {
          const { def, free } = tools.get(slug);
          const ann = FLAGSHIP_WRITERS.has(slug) ? WRITE
            : FLAGSHIP_OPEN_WORLD.has(slug) ? OPEN
            : SAFE;
          const access = free
            ? "[free, no wallet]"
            : `[wallet-required, ${def.price}/call]`;
          const walletNote = free
            ? ""
            : " This hosted connector holds no wallet: pay it here over MPP, or run npx agent402-mcp with a funded wallet (AGENT_KEY) or a prepaid credits key already issued (AGENT402_CREDITS_KEY), or any x402 client.";
          const outSchema = FLAGSHIP_OUTPUT_SCHEMAS[slug]
            || outputSchemaFromExample(def.discovery?.output?.example);
          return {
            name: mcpNameOf(slug),
            title: def.name,
            annotations: { title: def.name, ...ann },
            description: `${access} ${def.description}${returnsHint(def)}${walletNote}`,
            inputSchema: schemaOf(def),
            outputSchema: outSchema,
          };
        }),
        // request_tool is the only meta tool that WRITES (a wish row).
        {
          name: META_MCP_NAMES.request_tool,
          title: "Request a tool Agent402 does not have",
          annotations: {
            title: "Request a tool Agent402 does not have",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
          description: `[free] Tell Agent402 about a capability its 500+ tools do not cover (catalog size ${tools.size}). Use it after catalog.search or catalog.find came back with nothing that fits, instead of giving up: requests are clustered by need, and the ones that keep coming up get built. Records demand only - it never returns a tool or runs anything. Same intake as POST ${baseUrl}/api/wish; aggregate demand is public at ${baseUrl}/api/wishes.`,
          inputSchema: {
            type: "object",
            properties: {
              need: { type: "string", maxLength: 500, description: 'What you needed and could not find, in plain language, e.g. "convert a HEIC image to JPEG" or "look up a UK company by registration number"' },
              context: { type: "string", maxLength: 300, description: "Optional: what you were trying to accomplish, or the input you had - helps disambiguate similar-sounding requests." },
            },
            required: ["need"],
            additionalProperties: false,
          },
          outputSchema: META_OUTPUT_SCHEMAS["demand.request"],
        },
        {
          // Dotted Smithery Naming (server.describe). Prior snake/digit names
          // remain CallTool aliases via resolveListedName.
          name: META_MCP_NAMES.describe_server,
          title: "About this Agent402 connector",
          annotations: { title: "About this Agent402 connector", ...SAFE },
          description: "[free] Describe this connector: flagship-first tools layer (search/answer as the front door), how to install (Claude Code / Cursor / npm), free vs paid tiers, and discovery URLs. Call this first.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: META_OUTPUT_SCHEMAS["server.describe"],
        },
        ...(decideFeedback ? [{
          name: "decide.feedback",
          title: "Report how a decide plan step went",
          annotations: { title: "Report how a decide plan step went", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          description: "[free] Report whether one step of a decide.plan decision worked (success or failure, optional 1-5 quality and latency). Needs the decisionId and feedbackToken that decide.plan returned; one verdict per step, a later report replaces it. Reports feed tool reliability in future rankings.",
          inputSchema: {
            type: "object",
            properties: {
              decisionId: { type: "string" },
              feedbackToken: { type: "string" },
              step: { type: "integer", minimum: 1 },
              outcome: { type: "string", enum: ["success", "failure"] },
              quality: { type: "integer", minimum: 1, maximum: 5 },
              latencyMs: { type: "integer", minimum: 0 },
              toolId: { type: "string", description: "Optional: a fallback you used instead of the step's primary tool" },
            },
            required: ["decisionId", "feedbackToken", "step", "outcome"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              ok: { type: "boolean" }, decisionId: { type: "string" }, step: { type: "integer" },
              toolId: { type: "string" }, outcome: { type: "string" }, replaced: { type: "boolean" },
            },
          },
        }] : []),
        ...(getLeaderboard ? [{
          // Dotted Smithery Naming (sellers.list). Prior snake/digit names
          // remain CallTool aliases via resolveListedName.
          name: META_MCP_NAMES.list_top_sellers,
          title: "List top x402 sellers",
          annotations: { title: "List top x402 sellers", ...SAFE },
          description: "[free] List ranked sellers from the on-chain settlement leaderboards. wire=x402 (default): x402 sellers by settled call counts, USDC totals and distinct buyers. wire=mpp: MPP (Machine Payments Protocol) sellers ranked by inbound USDC.e transfers on Tempo to the recipient their live 402 names (window count, rolling 7d/30d, distinct payers, volume; routable = this host's router will pay them). Use it to find other services in the open x402 / MPP ecosystem. This host's own wallet is excluded unless include is set to all.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 50, description: "How many sellers to return (default 10)." },
              sort: { type: "string", enum: ["usd", "calls"], description: "x402: rank by settled USDC (default) or by settled call count. mpp: usd = 7-day volume, calls = 7-day transfers (default)." },
              include: { type: "string", enum: ["external", "all"], description: "external (default) hides this host's own wallet; all includes it." },
              wire: { type: "string", enum: ["x402", "mpp"], description: "Which leaderboard: x402 (default, Base USDC settlements) or mpp (Tempo USDC.e transfers to MPP sellers)." },
            },
            additionalProperties: false,
          },
          outputSchema: META_OUTPUT_SCHEMAS["sellers.list"],
        }] : []),
      ]),
    }));

    /** Paid tool over native MPP: loopback to the real paid route.
     *
     *  For the expensive composites this also decides, per request, whether to
     *  answer with a task handle instead of blocking (MCP Tasks extension). The
     *  decision is ours alone - the spec makes the server the sole decider - and
     *  is taken only when the client declared the extension ON THIS REQUEST.
     *
     *  SETTLEMENT IS UNMOVED. The loopback IS the paid request; a task just lets
     *  it outlive the MCP HTTP response that handed back the handle. Money still
     *  settles after the handler, only on a <400, on that same request. A
     *  failed or restart-orphaned run produced no 200 and therefore CANCELLED
     *  settlement. A cancelled or timed-out wait only stops THIS connector
     *  waiting: the paid request runs on and settles on a <400, and a charge
     *  that never reached the buyer is owed in the refund ledger. */
    async function payOverMpp(entry, reqParams, args, isNamed, ip, signal) {
      const meta = reqParams?._meta;
      const credentialHeader = credentialHeaderFromMeta(meta);
      // Same params shaping as the free path (flagship: args IS params;
      // catalog.call: {slug, params} envelope, JSON string or flattened).
      let params = isNamed ? args : args.params;
      if (typeof params === "string") { try { params = JSON.parse(params); } catch { params = {}; } }
      if (!params || typeof params !== "object" || Array.isArray(params)) { const { slug: _drop, ...rest } = args || {}; params = rest && Object.keys(rest).length ? rest : {}; }
      const startedAt = Date.now();
      const idempotencyKey = meta?.["org.agent402/idempotency-key"];

      const taskEligible = Boolean(tasks) && EXPENSIVE_COMPOSITE_SLUGS.has(entry.def.slug) && clientDeclaresTasks(reqParams);
      if (taskEligible) {
        const handle = await runAsTask(entry, meta, params, credentialHeader, ip, isNamed, startedAt, idempotencyKey);
        if (handle) return handle;
        // Fell through: the run finished (or was refused) inside the gate window,
        // so answer synchronously exactly as a blocking call would.
      }

      // The paid loopback must end BEFORE this connector's own request
      // deadline. When the deadline won, the transport answered a JSON-RPC
      // -32603 that MCP hosts render as a bare "Error occurred during tool
      // execution", and the loopback was cut mid-flight. Bounded here, the
      // caller gets a tool result naming what happened instead.
      let r;
      try {
        r = await mppLoopback({ def: entry.def, params, credentialHeader, ip, signal, idempotencyKey, timeoutMs: PAID_LOOPBACK_TIMEOUT_MS, heartbeatToken });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: true, statusCode: timedOut ? 504 : 502, errorMessage: timedOut ? "paid loopback timed out" : "paid loopback failed", inputKeys: Object.keys(params || {}) });
        console.warn(`[mcp] tools/call failed class=${timedOut ? "paid-timeout" : "paid-loopback-error"} tool=${entry.def.slug} after=${Date.now() - startedAt}ms`);
        // "Not charged" is only true when no payment credential rode along:
        // with one, the server-side request may have settled after this
        // connector stopped waiting.
        const paid = Boolean(credentialHeader);
        return {
          content: [{ type: "text", text: connectorCutoffText({
            label: `Agent402 (${entry.def.slug})`, seconds: Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000), paid,
            route: entry.def.route, error: timedOut ? null : (err?.message || err),
          }) }],
          isError: true,
        };
      }
      return translateMppResponse(entry, meta, params, startedAt, isNamed, r);
    }

    /** Turn a completed loopback response into the MCP answer. Shared by the
     *  blocking path and the task path, so a task result is byte-identical to
     *  what the blocking call would have returned (an ext-tasks MUST). Throws
     *  McpError(-32042) for a payment ask. */
    function translateMppResponse(entry, meta, params, startedAt, isNamed, r, { softAsk = true } = {}) {
      if (r.status === 402) {
        const challenges = challengesFromHeader(r.headers.get("www-authenticate"));
        if (!challenges.length) {
          // No MPP challenge on the 402 (gates not minting for this route):
          // fall back to the paid-access instructions rather than an empty ask.
          return { content: [{ type: "text", text: walletRequiredText(entry.def) }], isError: true };
        }
        const problem = problemOf(r.json);
        // mppx's wire: -32042 (no credential presented) / -32043 (the caller
        // PRESENTED a credential and it was refused) + {httpStatus, challenges,
        // problem?}. The code keys on whether a credential rode in _meta, not on
        // the body: an unpaid 402 may carry a problem-shaped body too. A refused
        // credential's problem says why; a first ask carries only the
        // challenges. Price rides inside each challenge's request.amount.
        const presented = Boolean(credentialHeaderFromMeta(meta));
        // A FIRST ask is answered as a tool result, not a JSON-RPC error:
        // MCP hosts that do not speak MPP show -32042 as a bare "Error occurred
        // during tool execution". The result carries readable instructions, and
        // the same challenges ride in _meta["org.paymentauth/payment-required"],
        // which mppx's McpClient (0.8+) pays exactly like the error. The
        // connector is stateless, so a capability declared at initialize cannot
        // be consulted here. A REFUSED credential keeps -32043, and a caller
        // on the tasks path (which declares that extension per request) keeps
        // -32042, which is how a task records a payment ask.
        if (!presented && softAsk) {
          return {
            content: [{ type: "text", text: walletRequiredText(entry.def) }],
            isError: true,
            _meta: { [MCP_PAYMENT_REQUIRED_META]: { httpStatus: 402, challenges, ...(problem ? { problem } : {}) } },
          };
        }
        // The message is what a host that does not speak MPP shows its user,
        // so a first ask carries every other way to pay, not only the MPP one.
        // Code and data are unchanged: an MPP client reads those, never the text.
        throw new McpError(presented ? MCP_PAYMENT_VERIFICATION_FAILED_CODE : MCP_PAYMENT_REQUIRED_CODE, problem?.detail || `Payment Required: ${walletRequiredText(entry.def)}`, { httpStatus: 402, challenges, ...(problem ? { problem } : {}) });
      }
      if (r.status >= 400) {
        onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: true, statusCode: r.status, errorMessage: String(r.json?.error || r.text || r.status).slice(0, 200), inputKeys: Object.keys(params || {}) });
        const detail = r.json ? JSON.stringify(withoutPaymentRequired(r.json)) : String(r.text || "").slice(0, 500);
        return { content: [{ type: "text", text: `Agent402 (${entry.def.slug}) HTTP ${r.status}${r.status >= 400 && r.status < 500 ? " - not charged" : " - not charged (settlement runs only after a successful handler)"}: ${detail}` }], isError: true };
      }
      onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: false });
      const receipt = receiptFromHeader(r.headers.get("payment-receipt"));
      const receiptMeta = receipt ? { [MCP_RECEIPT_META]: { ...receipt, ...(challengeIdFromMeta(meta) ? { challengeId: challengeIdFromMeta(meta) } : {}) } } : {};
      if (r.bytes) {
        return {
          content: [{ type: "image", data: r.bytes.toString("base64"), mimeType: r.contentType.split(";")[0] }],
          structuredContent: { slug: entry.def.slug, result: { contentType: r.contentType.split(";")[0], encoding: "base64", note: "Binary payload is in the image content block" } },
          ...(receipt ? { _meta: receiptMeta } : {}),
        };
      }
      const result = r.json !== undefined ? r.json : { text: r.text };
      if (isNamed) return { ...mcpJsonResult(result), ...(receipt ? { _meta: receiptMeta } : {}) };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { slug: entry.def.slug, result },
        ...(receipt ? { _meta: receiptMeta } : {}),
      };
    }

    /**
     * Start a composite as a task. Returns a CreateTaskResult, or null when the
     * caller should just answer synchronously.
     *
     * The GATE WINDOW is what keeps payment honest. A 402 is decided BEFORE the
     * handler runs (@x402/express verifies first), so it comes back in
     * milliseconds. We therefore start the paid loopback and wait a short window
     * for it to settle one way or the other:
     *   - it resolves inside the window (402, a fast 4xx/5xx, or a quick 200)
     *     -> return null and let the caller answer synchronously, unchanged;
     *   - the window elapses with no response -> the payment gate has passed and
     *     the handler is genuinely running, so a task is the right answer.
     * A task is never minted for a call that has not cleared the paywall, and no
     * work is started twice: the SAME in-flight request becomes the task's run.
     */
    async function runAsTask(entry, meta, params, credentialHeader, ip, isNamed, startedAt, idempotencyKey) {
      // Capacity is checked BEFORE anything is spent. Over the ceiling we refuse
      // cheaply rather than starting a run we cannot hand back.
      if (tasks.atCapacity()) {
        return {
          content: [{ type: "text", text: `Agent402 is at capacity for long-running ${entry.def.slug} runs right now - nothing was started and you were not charged. Retry shortly.` }],
          isError: true,
        };
      }
      // The run must OUTLIVE this HTTP response, so it gets its own abort
      // controller (the request's signal fires on res "close", which is exactly
      // what returning the handle causes) - and that controller is what
      // tasks/cancel aborts.
      const controller = new AbortController();
      const run = mppLoopback({
        def: entry.def, params, credentialHeader, ip,
        signal: controller.signal, idempotencyKey, heartbeatToken,
        timeoutMs: tasks.RUN_TIMEOUT_MS,
      });
      // Never leave an unhandled rejection while the gate window races.
      const settled = run.then((r) => ({ r }), (e) => ({ e }));

      let gateTimer = null;
      const gate = await Promise.race([
        settled,
        new Promise((resolve) => { gateTimer = setTimeout(() => resolve(null), TASK_GATE_MS); }),
      ]).finally(() => { if (gateTimer) clearTimeout(gateTimer); });
      if (gate) {
        // Finished inside the window. Hand the outcome back to the blocking path
        // rather than making the client poll for something already done.
        if (gate.e) throw gate.e;
        return translateMppResponse(entry, meta, params, startedAt, isNamed, gate.r, { softAsk: false });
      }

      const rec = tasks.create({ slug: entry.def.slug, controller });
      if (!rec) {
        // Durability failed, so we cannot promise a handle. Stop waiting on the
        // run and say so. The run has already cleared the paywall and keeps
        // going server-side, so it may still settle.
        try { controller.abort(); } catch { /* already aborted */ }
        return {
          content: [{ type: "text", text: `Agent402 could not durably record this ${entry.def.slug} run, so it cannot hand back a result. ${PAID_CUTOFF_TEXT}` }],
          isError: true,
        };
      }

      settled.then(({ r, e }) => {
        if (e) {
          const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
          if (aborted && tasks.get(rec.taskId)?.status === "cancelled") return; // cancel() already wrote the terminal state
          onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: true, statusCode: 504, errorMessage: aborted ? "task run aborted" : "task run failed", inputKeys: Object.keys(params || {}) });
          // Never relay an upstream/internal error body to the buyer.
          tasks.fail(rec.taskId, { code: TASK_INTERNAL_ERROR, message: aborted ? "The connector stopped waiting for the run." : "The run did not complete." },
            `The run's result did not reach this connector. ${PAID_CUTOFF_TEXT}`);
          return;
        }
        let out;
        try {
          out = translateMppResponse(entry, meta, params, startedAt, isNamed, r, { softAsk: false });
        } catch (err) {
          // A 402 decided after the gate window (a slow verify). It is a
          // JSON-RPC error on the underlying request, so the task FAILED - and
          // the challenges ride along so the client can pay and call again.
          const code = err instanceof McpError ? err.code : TASK_INTERNAL_ERROR;
          tasks.fail(rec.taskId, { code, message: err?.message || "Payment required.", ...(err?.data ? { data: err.data } : {}) }, "Payment was required for this call. You were not charged.");
          return;
        }
        // Spec: `failed` is for JSON-RPC errors only. A tool result that
        // completed carrying isError:true is a COMPLETED task whose result says
        // it went wrong (and our text already says "not charged"), so a caller
        // can never mistake it for a silent empty success.
        tasks.complete(rec.taskId, out, { receipt: receiptFromHeader(r.headers?.get?.("payment-receipt")), priceUsd: toolPriceUsd(entry.def.slug) });
      }).catch(() => { /* settled never rejects; belt and braces */ });

      return createTaskResult(rec);
    }

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name: rawName, arguments: args = {} } = req.params;
      const name = resolveListedName(rawName);
      if (scoped && HIDDEN_WHEN_SCOPED.has(name)) {
        return { content: [{ type: "text", text: `${rawName} is not available on ${path} - this endpoint serves one product (${[...flagshipSet].map(mcpNameOf).join(", ")}). The full catalog connector is ${baseUrl}/mcp.` }], isError: true };
      }
      try {
        if (name === "catalog.search") {
          // Funnel stage 1 (discovery) — same event the HTTP discovery
          // surfaces emit in server.js; env-gated no-op without PostHog.
          capturePostHogDiscovery({ surface: "mcp:catalog.search" });
          const q = args.query ?? "";
          const { rows: results, topScore, matched } = searchTools(q, args.limit);
          // Multi-tool workflows that match the same query — surface them so an
          // agent asking "audit a domain" sees the whole security-audit pack
          // (callable in ONE payment via skill-<slug>, or step-by-step via
          // prompts/get) alongside the tools.
          const workflows = rankSkillPacks(q, { k: 2, baseUrl, toolPriceUsd });
          // Weak/empty match: nudge toward request_tool instead of a dead
          // end. No wish recorded here — search_tools is a looser lexical
          // search than find_tool, not a task-intent signal; the explicit
          // request_tool call (or find_tool's find-miss capture) is the
          // actual demand signal.
          const weak = results.length === 0 || topScore < FIND_WEAK_SCORE;
          if (!results.length && !workflows.length) {
            return mcpJsonResult({
              results: [],
              message: `No tools matched "${q}". Full catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
              hint: WISH_HINT_TEXT,
            });
          }
          return mcpJsonResult({
            results,
            // THE CEILING HAS TO ANNOUNCE ITSELF, and on this surface most of
            // all: the consumer is an agent, which reads fields and not prose.
            // `limit: 50` silently served 10 rows and the envelope carried
            // nothing to separate "ten tools can do this" from "ten is our
            // maximum" - the same silence that had a seller's checker read one
            // page of /api/index as the whole index (2026-09-22). /api/find and
            // /api/route grew topMax the same day; the two MCP tools serving
            // the identical rankings to agents did not.
            limitMax: SEARCH_LIMIT_MAX,
            ...partialFields(matched, results.length),
            ...clampFields(args.limit, SEARCH_LIMIT_MAX, "limit"),
            ...(workflows.length ? { workflows, workflowsUsage: "One call: catalog.call { slug: 'skill-' + workflows[i].slug, params: { …promptArgs } } (or POST workflows[i].route) runs every step for the single price in workflows[i].price. To orchestrate the steps yourself instead: prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } } - that bills each underlying tool separately." } : {}),
            ...(weak ? { hint: WISH_HINT_TEXT } : {}),
            usage: 'catalog.call {"slug": …, "params": …}',
          });
        }
        if (name === "catalog.find") {
          capturePostHogDiscovery({ surface: "mcp:catalog.find" });
          const taskStr = String(args.task ?? args.query ?? "");
          const r = findTools(catalog, taskStr, { k: args.limit, baseUrl, powSlugs: freeSlugs });
          // Seller bridge (same as /api/find): a seller-name task points at
          // the indexed seller and the router instead of missing silently.
          let relatedSellers;
          try {
            const rel = findRelatedSellers(taskStr, routableSellerSummaries());
            if (rel.length) relatedSellers = rel.map((x) => ({ ...x, sellerInfo: `${baseUrl}/api/index?seller=${encodeURIComponent(x.host)}`, routeAcross: `${baseUrl}/api/route?q=${encodeURIComponent(taskStr)}&include=external` }));
          } catch { /* best-effort */ }
          const results = r.results.map((t) => ({
            slug: t.slug,
            price: t.price,
            access: t.computePayable ? "free here (rate-limited)" : "wallet required (USDC via x402 - use the agent402-mcp npm server)",
            // Discovery up top: same ordering as /api/find — the answer to
            // "how do I call this" (callWith / example / required) should be
            // visible before the verbose description/schema fields. `required`
            // is always an array so callers can scan without a guard.
            callWith: { name: META_MCP_NAMES.call_tool, arguments: { slug: t.slug, params: t.example ?? {} } },
            example: t.example,
            required: Array.isArray(t.required) ? t.required : [],
            inputSchema: t.inputSchema,
            description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
          }));
          // Weak/empty match: this IS a task-intent signal (unlike
          // search_tools' looser lexical search), so capture it as a
          // find-miss wish — fire-and-forget, rate-limit exempt, never
          // blocks the response.
          const topScore = r.results[0]?.score ?? 0;
          // A capability gap phrased in English never cleared the score floor,
          // so this signal only ever captured gibberish. The rarest-term check
          // is what makes a genuine miss observable.
          const weak = r.count === 0 || topScore < FIND_WEAK_SCORE || r.rarestTermCovered === false;
          // Free multi-step sketch (src/plan-sketch.js), the same one /api/find
          // returns: each named step ranked by this search, no model call.
          let plan = null;
          try {
            const d = catalog["POST /api/decide"];
            plan = buildPlanSketch(taskStr, {
              rank: (task) => findTools(catalog, task, { k: 3, baseUrl, powSlugs: freeSlugs }),
              weakScore: FIND_WEAK_SCORE,
              upgrade: d ? { tool: "decide", route: "POST /api/decide", mcp: "decide.plan", price: d.price, note: "a judged plan with your inputs filled in and fallbacks checked; the fee is credited toward running it with decide.execute" } : null,
            });
          } catch { plan = null; }
          if (plan) {
            for (const st of plan.steps) {
              if (st.match === "strong") continue;
              try { recordWish({ need: st.task, source: "find-miss", ip }); } catch { /* best-effort */ }
            }
          } else if (weak && taskStr.trim() && !relatedSellers) {
            try { recordWish({ need: taskStr.trim(), source: "find-miss", ip }); } catch { /* best-effort */ }
          }
          if (plan && !results.length && !r.packs?.length) {
            return mcpJsonResult({ task: taskStr, results: [], plan, usage: "Run each plan step with catalog.call { slug, params } in order." });
          }
          if (!results.length && !r.packs?.length) {
            return mcpJsonResult({
              task: taskStr,
              results: [],
              message: `No tool matched "${taskStr}". Browse the catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
              ...(weak && !relatedSellers ? { hint: WISH_HINT_TEXT } : {}),
            });
          }
          return mcpJsonResult({
            task: r.query,
            results,
            // findTools already computes and publishes these on /api/find; this
            // envelope rebuilt itself row by row and dropped both, so the HTTP
            // caller learned the ranking was cut and the agent did not. Passed
            // through rather than recomputed, so the two surfaces cannot drift.
            topMax: r.topMax,
            truncated: !!r.truncated,
            returned: results.length,
            // Passed THROUGH from findTools, never recomputed here: recomputing
            // is how the HTTP caller learned the ranking was cut and the agent
            // did not. `matched` is the number an agent concluding "no tool
            // exists for this" has to see.
            matched: r.matched,
            complete: r.complete,
            ...(r.packs?.length ? { workflows: r.packs, workflowsUsage: "One call: catalog.call { slug: 'skill-' + workflows[i].slug, params: { …promptArgs } } (or POST workflows[i].route) runs every step for the single price in workflows[i].price. To orchestrate the steps yourself instead: prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } } - that bills each underlying tool separately." } : {}),
            ...(relatedSellers ? { relatedSellers } : {}),
            ...(plan ? { plan } : {}),
            ...(weak && !relatedSellers && !plan ? { hint: WISH_HINT_TEXT } : {}),
            usage: "Run catalog.call with the chosen {slug, params}. Free results execute here; paid tools are payable here over MPP or via the agent402-mcp npm server (a wallet, or a prepaid credits key already issued).",
          });
        }
        if (name === "demand.request") {
          // The other half of the wish loop: an explicit "I needed something
          // you don't have" signal, same recordWish path as POST /api/wish
          // (source "mcp" instead of "api") — rate-limited per-IP/global,
          // clustered by normalized text, surfaced at GET /api/wishes.
          try {
            const result = recordWish({ need: args.need, context: args.context, source: "mcp", ip });
            return mcpJsonResult(result);
          } catch (err) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
        }
        if (name === "server.describe") {
          capturePostHogDiscovery({ surface: "mcp:about" });
          const install = mcpInstallHints(baseUrl);
          return mcpJsonResult({
            service: baseUrl,
            connector: "hosted free tier (authless)",
            maintainer: "Havok Holdings LLC",
            positioning: `Agent402 is the applied layer of Agentic Finance: software agents that pay and get paid on their own, per request, over the two open wires - x402 and MPP (Machine Payments Protocol) - both answered on the same 402. Definition + glossary: ${baseUrl}/agentic-finance, ${baseUrl}/glossary.`,
            // Flagship-first positioning: search/answer as the default job,
            // evergreen 500+ catalog, models and reports named beside the tools.
            startHere: {
              firstJob: `One fact: call web.search or web.answer.${catalog["POST /api/decide"] ? " A job with more than one step: call decide.plan, then decide.execute (the plan fee is credited toward the run)." : ""} Otherwise catalog.find with your task. Agent402 sells three things on one key: deterministic utilities (no model in that serving path), a metered model gateway on the OpenAI and Anthropic wires (/v1/metered), and finished report products. Flagship tools first, 500+ long-tail tools via catalog.find / catalog.search / catalog.call.`,
              flagships: [...flagshipSet].map((slug) => ({
                mcpName: mcpNameOf(slug),
                slug,
                price: tools.get(slug).def.price,
                access: tools.get(slug).free ? "free here" : "wallet required on this hosted connector",
              })),
              llmGateway: `OpenAI-compatible LLM gateway at ${baseUrl}/v1 - flat per-call pricing: chat nano $0.003, auto (eval-ranked model routing) $0.01, embeddings $0.002. No API key: a funded wallet IS the account (x402 settles per call). Reach tiers via catalog.call (slugs v1-chat-nano, v1-chat-auto, v1-embeddings) on the npm server.`,
              freeTier: `${freeCount} pure-CPU tools run free right here with no wallet - payable with ~milliseconds of proof-of-work CPU (discover via catalog.find / catalog.search).`,
            },
            install,
            tools: tools.size,
            toolsEvergreen: "500+",
            freeHere: freeCount,
            walletOnly: tools.size - freeCount,
            rateLimit: `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`,
            workflows: {
              count: SKILL_PACKS.length,
              usage: "prompts/list → prompts/get { name: '<slug>', arguments: { … } } - same slugs as below.",
              items: SKILL_PACKS.map((p) => ({
                slug: p.slug,
                title: p.title,
                toolCount: (p.toolSlugs || []).length,
                tagline: p.tagline,
              })),
            },
            clientsSeenSinceBoot: Object.fromEntries([...mcpClients].sort((a, b) => b[1] - a[1]).slice(0, 20)),
            paidAccess: `Every tool, no rate limit: pay per call in ${RAILS_PAREN} via the x402 protocol - npx agent402-mcp with AGENT_KEY (EVM) and/or SOLANA_AGENT_KEY (Solana), or a prepaid credits key already issued (AGENT402_CREDITS_KEY), or any x402 HTTP client - or over MPP (Machine Payments Protocol) with an mppx client, settling USDC on Base/Celo or USDC.e (and PathUSD) natively on Tempo. No signup, no API key; most tools $0.001–$0.02/call, LLM gateway tiers $0.002–$0.50, multi-tool skill packs ${PACK_PRICE_RANGE.text}.`,
            ...(getLeaderboard ? { ecosystem: "Call sellers.list to see which x402 sellers (any wallet, not just this host) are settling the most USDC (primarily on Base) in the last 24h, or sellers.list with wire=mpp for MPP sellers ranked by on-chain USDC.e transfers on Tempo - discovers the live economy beyond this catalog." } : {}),
            missingATool: "Call demand.request (or POST /api/wish) with what you needed. We cluster and track demand - repeated requests get built.",
            docs: `${baseUrl}/llms.txt`,
          });
        }
        if (name === "decide.feedback" && decideFeedback) {
          try { return mcpJsonResult(decideFeedback(args, { ip })); }
          catch (err) { return { content: [{ type: "text", text: err.statusCode && err.statusCode < 500 ? err.message : "feedback failed" }], isError: true }; }
        }
        if (name === "sellers.list" && getLeaderboard && args.wire === "mpp") {
          // The MPP leaderboard (src/mpp-leaderboard.js) - same row discipline
          // as the x402 branch below: token-cheap rows, self hidden by default,
          // seller names are self-reported external content and marked so.
          const lb = (typeof getMppLeaderboard === "function" ? getMppLeaderboard() : null) || { rows: [], stale: true };
          const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
          const sort = args.sort === "usd" ? "usd" : "calls";
          const include = args.include === "all" ? "all" : "external";
          let board = Array.isArray(lb.rows) ? lb.rows.filter((r) => r.transfers > 0 || (r.d30?.transfers || 0) > 0) : [];
          if (include === "external") board = board.filter((r) => !r.self);
          board = board.slice().sort((a, b) => sort === "usd"
            ? ((b.d7?.volumeUsdc || 0) - (a.d7?.volumeUsdc || 0)) || (b.transfers - a.transfers)
            : ((b.d7?.transfers || 0) - (a.d7?.transfers || 0)) || (b.transfers - a.transfers)).slice(0, limit);
          const rows = board.map((r, i) => ({
            rank: i + 1,
            name: r.self ? "this host" : (r.sellers || []).map((s) => s.name).join(", ") || "unnamed recipient",
            network: "eip155:4217",
            wallet: r.recipient,
            homepage: r.sellers?.[0]?.url || null,
            transfersWindow: r.transfers,
            transfers7d: r.d7?.transfers || 0,
            transfers30d: r.d30?.transfers || 0,
            payersWindow: r.payers,
            volumeUsdc7d: Math.round((r.d7?.volumeUsdc || 0) * 10000) / 10000,
            routable: !!r.routable,
            ...(r.self ? {} : { untrustedContent: true }),
          }));
          return mcpJsonResult({
            wire: "mpp",
            measure: "inbound USDC.e transfers on Tempo (chain 4217) to the recipient each seller's live MPP challenge names - a window read plus rolling 7d/30d, a proxy for settlements, not lifetime",
            window: lb.window ? `~${lb.window.approxHours}h (${lb.window.blocks} blocks)` : null,
            asOf: lb.generatedAt ? new Date(lb.generatedAt).toISOString() : null,
            sort, include,
            totalSellers: Array.isArray(lb.rows) ? lb.rows.length : 0,
            results: rows,
            ...(rows.some((r) => r.untrustedContent) ? { containsUntrustedContent: true } : {}),
            ...(lb.stale ? { note: "Leaderboard is stale or still warming - the first on-chain read runs a couple of minutes after boot and every 30 min after." } : {}),
            source: `${baseUrl}/api/mpp-leaderboard`,
          });
        }
        if (name === "sellers.list" && getLeaderboard) {
          const snap = getLeaderboard() || {};
          const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
          const sort = args.sort === "calls" ? "calls" : "usd";
          const include = args.include === "all" ? "all" : "external";
          // Self-wallet filter: agents asking "who else is on x402?" want the
          // host's own wallet hidden by default. The hosted catalog ranks
          // because of this very tool process, so leaving it in skews the top
          // toward Agent402 itself.
          const self = (process.env.WALLET_ADDRESS || "").toLowerCase();
          let board = Array.isArray(snap.leaderboard) ? snap.leaderboard : [];
          if (include === "external" && self) board = board.filter((r) => (r.wallet || "").toLowerCase() !== self);
          board = rankLeaderboard(board, sort).slice(0, limit);
          // Trim to a token-cheap row shape — full row (origins, endpoints,
          // etc.) is at /api/leaderboard for agents that want it. Round USDC
          // to 4dp to match the HTML page's display precision and keep the
          // JSON compact.
          // F09: a seller's name/homepage is self-reported, external content.
          // Mark every non-self row as untrusted data so a downstream selecting
          // agent never treats seller copy as an instruction. Our own row
          // (matching WALLET_ADDRESS) is trusted and unmarked.
          const rows = board.map((r) => {
            const isSelf = self && (r.wallet || "").toLowerCase() === self;
            return {
              rank: r.rank,
              name: r.name,
              network: r.network,
              wallet: r.wallet,
              homepage: r.homepage || null,
              callsSettled: r.callsSettled || 0,
              totalUsd: Math.round((r.totalUsd || 0) * 10000) / 10000,
              uniqueBuyers: r.uniqueBuyers || 0,
              ...(isSelf ? {} : { untrustedContent: true }),
            };
          });
          const anyExternal = rows.some((r) => r.untrustedContent);
          return mcpJsonResult({
            window: snap.windowLabel || "24h",
            asOf: snap.asOf,
            sort,
            include,
            totalSellers: (snap.leaderboard || []).length,
            results: rows,
            ...(anyExternal ? { containsUntrustedContent: true } : {}),
            ...(snap.warming || snap.scanSkipped ? { note: "Cache is warming - results may be partial. Retry in ~60s." } : {}),
            source: `${baseUrl}/api/leaderboard`,
          });
        }
        // Curated tools called by name: route to the same handler as
        // call_tool but use `name` as the slug and `args` as params directly.
        if (name === "payment.info") {
          return mcpJsonResult({
            connector: "hosted free tier - no wallet is held on this connector (authless)",
            credits: { onSale: false, how: "new credits are not on sale; a key already issued keeps working: Authorization: Bearer a402_<key> on any paid HTTP route except the wallet-identity-bound ones, or AGENT402_CREDITS_KEY on the agent402-mcp npm server; the list price is held before the call and debited only on success", balance: `${baseUrl}/api/credits/balance` },
            // DERIVED, never typed. This block quoted the pre-2026-08-23 ladder
            // for three weeks - every figure understated 1.7x to 3.4x - and an
            // agent budgeting from a machine surface under-budgets, pays, and
            // is refused. llms.txt was right the whole time because it derives
            // its numbers; this does the same now.
            reports: { what: `finished, cited report products with a data appendix - ${reportLadder().agentLadder} - the same endpoints over x402/MPP or by card`, human: `${baseUrl}/reports`, humanPricing: `people pay ${reportLadder().cardLadder} by card; the card price includes payment processing, so an agent paying per call pays the lower tool price above for the same report`, monitors: `${baseUrl}/monitors`, monitorPricing: reportLadder().monthlySentence },
            freeTier: {
              pureCpuToolsFree: freeCount,
              how: "pure-CPU tools run free here (rate-limited); wallet-only tools are payable on this connector over MPP (the first ask is a tool result whose challenges ride in _meta[\"org.paymentauth/payment-required\"]; on the tasks path the ask is JSON-RPC error -32042, and a presented credential that is refused is -32043; send the credential in _meta[\"org.paymentauth/credential\"], receipt returns in _meta[\"org.paymentauth/receipt\"] - mppx's McpClient.wrap() handles it) or via the npm server with a wallet",
              proofOfWork: "a walletless client can solve a proof-of-work puzzle instead of paying on eligible tools",
            },
            pay: {
              model: "HTTP 402 + x402, settled in USDC on-chain, non-custodial (you hold the key)",
              mpp: `every paid endpoint also accepts MPP (Machine Payments Protocol, the Payment HTTP auth scheme): the same 402 carries a WWW-Authenticate: Payment challenge, an mppx client pays out of the box, settling USDC on Base/Celo or USDC.e (and PathUSD) natively on Tempo - see ${baseUrl}/what-is-mpp`,
              rails: RAILS_PAREN,
              setup: "run the agent402-mcp npm server: `npx agent402-mcp` with AGENT_KEY=0x<private key> for EVM (USDC on Base/Polygon/Arbitrum, USDG on Robinhood via AGENT402_NETWORKS) and/or SOLANA_AGENT_KEY=<base58 secret> for Solana. No signup, no API key.",
              // DERIVED. Both ranges here were hand-typed and kept through two
              // repricings: the pack ceiling was over ten times the real one and
              // the report range stopped a tier short of the priciest product.
              // An agent budgets from this surface, so an under-quote is a 402 it
              // was told not to expect - the same defect this tool's `reports`
              // line was fixed for, one field away. test-price-prose pins the
              // retired figures by name, so do not quote them back in here.
              prices: `most tools $0.001–$0.02 per call, LLM gateway tiers $0.002–$0.50 (the metered tier is quoted per request), multi-tool skill packs ${PACK_PRICE_RANGE.text}, report products ${agentReportPriceRange()?.text || "priced per product"} - see each tool's exact price in catalog.search results`,
              llmGateway: `the /v1 OpenAI-compatible endpoints (chat nano $0.003, auto $0.01, embeddings $0.002) settle the same way - point any OpenAI SDK at ${baseUrl}/v1 through an x402-paying fetch; no API key, the wallet is the account`,
            },
            ...(mppStartHere.length ? { mppStartHere: { what: `fast, low-priced routes that ${mppFlagshipOffersPhrase()}: a good first call for a new MPP client (call by slug with catalog.call, or pay the HTTP route with mppx)`, routes: mppStartHere, more: `${baseUrl}/what-is-mpp#start-here` } } : {}),
            spendControls: { perCall: "AGENT402_MAX_PER_CALL caps any single call", totalBudget: "AGENT402_BUDGET caps cumulative spend for the session" },
            balanceAndHistory: {
              balance: "check a wallet's USDC balance via catalog.call with slug wallet-balances (multi-chain) or wallet-balance (single)",
              transactions: "pull a wallet's transaction history via catalog.call with slug wallet-transactions",
              note: "these are on-chain read tools - they need a wallet/paid access, or run them on the npm server",
            },
          });
        }
        // First-class tools are exposed under their MCP name (mcpNameOf), but
        // the router accepts every historical spelling — exposed name, legacy
        // snake form, raw kebab slug — so no existing caller breaks across
        // renames. Flagships may be free or wallet-only; wallet-only falls
        // through to the paid-access response below (same as call_tool).
        const namedSlug = namedToolSlugs.get(name) ?? namedToolSlugs.get(name.replace(/_/g, "-")) ?? null;
        const isNamed = namedSlug !== null;
        // After resolveListedName, catalog.call is the envelope path; everything
        // else must be a named flagship (or legacy alias mapped above).
        if (name !== "catalog.call" && !isNamed) {
          return { content: [{ type: "text", text: `Unknown tool "${rawName}".` }], isError: true };
        }
        const resolvedSlug = isNamed ? namedSlug : String(args.slug ?? "");
        const entry = tools.get(resolvedSlug);
        if (!entry) {
          return { content: [{ type: "text", text: `Unknown slug "${resolvedSlug}". Use catalog.search to find the right slug.` }], isError: true };
        }
        if (!entry.free) {
          // Native MPP (2026-08-19): with the MPP gates mounted, a paid tool is
          // payable right here on the connector. The call is replayed as a
          // loopback HTTP request to our own paid route so the REAL gates
          // verify + settle (settlement authority unchanged); we only
          // translate wire shapes (see src/mcp-mpp.js). Without the gates
          // (no MPP_SECRET_KEY) the old paid-access instructions stand.
          if (!mppLoopback) return { content: [{ type: "text", text: walletRequiredText(entry.def) }], isError: true };
          return await payOverMpp(entry, req.params, args, isNamed, ip, signal);
        }
        if (rateLimited(ip)) {
          return {
            content: [{ type: "text", text: `Free-tier rate limit reached (${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour). For unmetered access pay per call via x402: npx agent402-mcp with AGENT_KEY. ${baseUrl}/llms.txt` }],
            isError: true,
          };
        }
        // Flagship tools called by name: args IS the params (no envelope).
        // call_tool path: accept params as object, JSON string, or flattened.
        let params;
        if (isNamed) {
          params = args;
        } else {
          // Accept params as an object OR a JSON string — LLM clients (e.g.
          // some Claude Code calls) often stringify object arguments.
          //
          // ALSO: many LLMs ignore the {slug, params} envelope and flatten —
          // e.g. { slug: "whois", domain: "example.com" } instead of
          // { slug: "whois", params: { domain: "example.com" } }. When
          // `params` is missing/invalid, treat the rest of `args` as params.
          params = args.params;
          if (typeof params === "string") {
            const s = params.trim();
            try { params = JSON.parse(s); }
            catch {
              const eq = s.indexOf("=");
              params = eq > 0 ? { [s.slice(0, eq).trim()]: s.slice(eq + 1).trim() } : {};
            }
          }
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            const { slug: _drop, ...rest } = args;
            params = rest && typeof rest === "object" && Object.keys(rest).length ? rest : {};
          }
        }
        // Same contract as the express kit routes; handlers only see input.
        // Time the call so the analytics dispatcher gets accurate latency for
        // MCP traffic (same as the HTTP path). Errors here flow into the
        // catch below and are reported with errored:true.
        const startedAt = Date.now();
        let result;
        try {
          // F14: don't start work for a request already aborted (deadline/
          // disconnect), and hand the signal to the handler so a signal-aware
          // one (or a fetch inside it) can bail early. CPU-bound handlers still
          // run to completion, but the transport is closed and the slot is only
          // released after this promise settles (see the POST /mcp handler).
          if (signal?.aborted) throw Object.assign(new Error("request aborted"), { statusCode: 499 });
          result = await entry.def.handler(params, { headers: {}, query: params, body: params, ip, signal });
        } catch (handlerErr) {
          // statusCode lets the analytics dispatcher split 4xx (bad input) from
          // 5xx (handler/upstream broke). errorMessage flows into the diagnostic
          // log so we can spot patterns like a single bad caller hammering one
          // tool with the wrong field shape.
          onServed(entry.def.slug, {
            latencyMs: Date.now() - startedAt,
            errored: true,
            statusCode: handlerErr.statusCode || 500,
            errorMessage: handlerErr.message,
            inputKeys: params && typeof params === "object" ? Object.keys(params) : [],
          });
          // Self-correction envelope: when the call fails the LLM caller almost
          // always has enough information in the original tool description, but
          // it ignored it. Echo the expected shape + a working example back so
          // the next attempt can fix itself without another search_tools call.
          //
          // ...EXCEPT WHEN THE FAILURE WAS NOT THE INPUT. Every error took this
          // branch, including an upstream that refused or throttled US, and to
          // an agent "here is the expected shape, call again" reads as one
          // instruction: reshape the input and retry. It would retry into a host
          // that is rate-limiting us, and conclude its own input was wrong about
          // a subject it got right. Same envelope, same defect, one surface over
          // from the HTTP route binder - which is the reason to fix the class
          // here rather than the instance there.
          const upstreamStatus = Number.isInteger(handlerErr?.upstreamStatus) ? handlerErr.upstreamStatus : null;
          const attribution = typeof handlerErr?.attribution === "string" ? handlerErr.attribution
            : upstreamStatus ? "upstream" : null;
          const fromUpstream = attribution === "upstream" || attribution === "upstream-access";
          const status = handlerErr.statusCode || 500;
          const hint = {
            error: handlerErr.message,
            tool: entry.def.slug,
            ...(upstreamStatus ? { upstreamStatus } : {}),
            ...(attribution ? { attribution } : {}),
            ...(Number.isInteger(handlerErr?.retryAfter) ? { retryAfterSeconds: handlerErr.retryAfter } : {}),
            ...(fromUpstream || status >= 500
              ? {
                whoseFault: "not your input - a third party this tool depends on refused or failed our request, and you were not charged",
                nextStep: attribution === "upstream"
                  ? "retry the SAME call later; changing the input will not help"
                  : "this resource is not reachable by this server; a different source may be, but the same call will keep failing",
              }
              : {
                expected: entry.def.discovery?.inputSchema?.properties || {},
                required: entry.def.discovery?.inputSchema?.required || [],
                example: entry.def.discovery?.input || {},
                callWith: {
                  name: META_MCP_NAMES.call_tool,
                  arguments: { slug: entry.def.slug, params: entry.def.discovery?.input || {} },
                },
              }),
          };
          return { content: [{ type: "text", text: JSON.stringify(hint, null, 2) }], isError: true };
        }
        onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: false });
        if (result && result.__binary) {
          return {
            content: [{ type: "image", data: Buffer.from(result.__binary).toString("base64"), mimeType: result.contentType }],
            structuredContent: {
              slug: entry.def.slug,
              result: { contentType: result.contentType, encoding: "base64", note: "Binary payload is in the image content block" },
            },
          };
        }
        // Named flagships: structuredContent is the native tool result (matches
        // FLAGSHIP_OUTPUT_SCHEMAS). call_tool: envelope {slug, result} so the
        // meta outputSchema has stable named fields while content text stays
        // the raw tool JSON agents already parse.
        if (isNamed) return mcpJsonResult(result);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { slug: entry.def.slug, result },
        };
      } catch (err) {
        // A payment ask is a JSON-RPC ERROR (-32042) by mppx's wire, not an
        // isError text the client would show verbatim - let the SDK send it.
        if (err instanceof McpError) throw err;
        return { content: [{ type: "text", text: `Agent402: ${err.message}` }], isError: true };
      }
    });

    return server;
  }

  // Wildcard CORS so browser-based MCP clients (inspector, web agents) work;
  // claude.ai connects server-side and ignores this. This is a deliberate
  // product requirement for a PUBLIC MCP connector (security audit A402-12).
  // It is safe because it is CREDENTIAL-FREE: Access-Control-Allow-Credentials
  // is never set, so browsers won't attach cookies, and the wildcard origin +
  // credentials combination is rejected by the browser anyway. There is no
  // cookie/session authority on /mcp; abuse is bounded by the per-IP/per-minute
  // and per-hour rate limits (AGENT402_MCP_MAX_PER_MIN / _PER_HOUR), not by
  /**
   * tasks/get, tasks/update and tasks/cancel, in the ext-tasks wire shape.
   * Returns a complete JSON-RPC response object (never throws).
   *
   * Access control: this connector is authless, so there is no authorization
   * context to bind a task to. The spec's instruction for exactly that case is
   * a high-entropy task id treated as the bearer (24 random bytes here) plus a
   * short TTL - the same model as /r/:sessionId. The 2026-07-28 extension has
   * no tasks/list, so there is no enumeration surface to withhold.
   */
  function handleTaskRpc(body) {
    const id = body?.id ?? null;
    const err = (code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
    const okResult = (result) => ({ jsonrpc: "2.0", id, result });

    // A client that did not declare the extension on THIS request has no
    // business driving tasks (spec: servers MUST return -32021).
    if (!clientDeclaresTasks(body?.params)) {
      return err(TASK_MISSING_CAPABILITY, "Missing required client capability", {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      });
    }
    const taskId = body?.params?.taskId;
    if (typeof taskId !== "string" || !taskId) return err(TASK_INVALID_PARAMS, "Failed to retrieve task: taskId is required and must be a string");

    let rec;
    try { rec = tasks.get(taskId); } catch { return err(TASK_INTERNAL_ERROR, "Internal error reading task state"); }
    if (rec === "expired") return err(TASK_INVALID_PARAMS, "Failed to retrieve task: Task has expired");
    if (!rec) return err(TASK_INVALID_PARAMS, "Failed to retrieve task: Task not found");

    if (body.method === "tasks/get") return okResult(detailedTask(rec));
    if (body.method === "tasks/cancel") {
      // Cooperative and eventually consistent: we abort the live run, which
      // makes the paid request a non-200 and CANCELS settlement.
      try { tasks.cancel(taskId); } catch { return err(TASK_INTERNAL_ERROR, "Internal error cancelling task"); }
      return okResult(taskAck());
    }
    // tasks/update: this connector never elicits, so it never surfaces
    // inputRequests and a task never reaches input_required. Every
    // inputResponses key is therefore for an unknown request, which the spec
    // says to ignore. Acknowledge so a client is not left retrying.
    return okResult(taskAck());
  }

  // origin. DO NOT add Access-Control-Allow-Credentials here.
  app.use(path, (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Stateless mode: a fresh server+transport per POST, no session table. Every
  // JSON-RPC message (including initialize) is self-contained, which survives
  // redeploys and needs no sticky routing.
  app.post(path, async (req, res) => {
    // req.ip is derived via the app's "trust proxy" setting, so it's the real
    // client IP (the edge-appended XFF hop) — NOT a spoofable client-supplied
    // X-Forwarded-For value. This is the only abuse control on the free tier,
    // so it must not be bypassable by injecting a header.
    const ip = (req.ip || req.socket.remoteAddress || "?").trim();
    // R-11 outer gate #1: per-IP raw-request cap, BEFORE allocating anything.
    if (mcpReqLimiter.check(ip).limited) {
      return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: `Too many requests to ${path} - slow down and retry shortly.` }, id: req.body?.id ?? null });
    }
    // MCP Tasks (io.modelcontextprotocol/tasks). Answered here, ahead of the SDK
    // transport, for two reasons: polling must not consume a transport slot (it
    // is cheap and frequent), and the installed SDK implements the older
    // 2025-11-25 CORE tasks wire (tasks/result + tasks/list, nested `task`,
    // ttl/pollInterval), which is not the shape this extension puts on the wire.
    // It stays behind the per-IP request limiter above - the spec asks for rate
    // limiting on task operations to bound polling and id enumeration.
    if (tasks && isTaskMethod(req.body?.method)) {
      const handled = handleTaskRpc(req.body);
      return res.status(200).json(handled);
    }
    // R-11 outer gate #2: global in-flight transport ceiling, BEFORE building
    // the server/transport (bounds allocation under an initialize/malformed flood).
    if (mcpInFlight >= MCP_MAX_CONCURRENT) {
      return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint is at capacity - retry shortly." }, id: req.body?.id ?? null });
    }
    // Adoption telemetry: every MCP session announces its client at
    // initialize (e.g. "claude-ai", "claude-code"). In-memory since boot.
    const ci = req.body?.method === "initialize" ? req.body?.params?.clientInfo : null;
    if (ci?.name && mcpClients.size < 500) {
      // clientInfo is attacker-controlled — sanitize before it lands in the log
      // line OR the in-memory telemetry map (audit F24).
      const key = logSafe(`${ci.name}@${ci.version || "?"}`, 80);
      mcpClients.set(key, (mcpClients.get(key) || 0) + 1);
      console.log(`[mcp] initialize from ${key}`);
    }
    mcpInFlight++;
    let deadlineTimer = null;
    const ac = new AbortController();
    let transport = null;
    let run = null;
    try {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      // Client disconnect: abort in-flight handler work AND close the transport
      // (F14) — not just close the transport while the handler keeps running.
      res.on("close", () => { ac.abort(); try { transport.close(); } catch { /* already closing */ } });
      await buildServer(ip, ac.signal, typeof req.headers["x-heartbeat-token"] === "string" ? req.headers["x-heartbeat-token"] : null).connect(transport);
      run = transport.handleRequest(req, res, req.body);
      // R-11/F14: per-request deadline. On fire, abort the handler and close the
      // transport so it settles, then (in finally) await that settle before the
      // slot is released — mcpInFlight never undercounts truly-live work.
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          ac.abort();
          try { transport.close(); } catch { /* already closing */ }
          reject(Object.assign(new Error("mcp request deadline exceeded"), { __deadline: true }));
        }, MCP_REQ_DEADLINE_MS);
      });
      await Promise.race([run, deadline]);
    } catch (err) {
      if (!res.headersSent) {
        // A tools/call that fails at the TRANSPORT used to be a JSON-RPC
        // -32603 ("mcp request deadline exceeded"), which MCP hosts show as a
        // bare "Error occurred during tool execution" with no reason. For a
        // tool call the answer is a tool RESULT that says what happened; other
        // methods keep the JSON-RPC error. Every such failure is logged.
        const method = String(req.body?.method || "?");
        const tool = logSafe(String(req.body?.params?.name || ""), 60);
        const cls = err.__deadline ? "deadline" : "internal";
        console.warn(`[mcp] ${logSafe(method, 40)} failed class=${cls}${tool ? ` tool=${tool}` : ""}`);
        if (method === "tools/call" && req.body?.id != null) {
          // Only a call that carried no payment credential is certainly
          // uncharged; a paid call may have settled server-side.
          let paid = false;
          try { paid = Boolean(credentialHeaderFromMeta(req.body?.params?._meta)); } catch { paid = false; }
          const label = `Agent402${tool ? ` (${tool})` : ""}`;
          const text = err.__deadline
            ? connectorCutoffText({ label, seconds: Math.round(MCP_REQ_DEADLINE_MS / 1000), paid })
            : `${label}: the connector hit an internal error handling this call (${String(err?.message || err).slice(0, 120)}). ${paid ? PAID_CUTOFF_TEXT : `${UNPAID_CUTOFF_TEXT} Retry shortly.`}`;
          res.status(200).json({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text }], isError: true } });
        } else {
          res.status(err.__deadline ? 504 : 500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: req.body?.id ?? null });
        }
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // F14: release the slot only AFTER the underlying handler has actually
      // terminated (bounded by MCP_DRAIN_MS), not merely when the deadline won
      // the race. Aborting + closing the transport above makes it settle fast.
      if (run) await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, MCP_DRAIN_MS))]);
      mcpInFlight--;
    }
  });

  // Stateless servers have no notification stream or session to manage.
  app.get(path, (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: `This MCP endpoint is stateless: POST JSON-RPC messages to ${path}.` },
    id: null,
  }));
  app.delete(path, (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Stateless endpoint - no session to terminate." },
    id: null,
  }));
}
