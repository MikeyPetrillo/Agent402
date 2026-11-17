import { frontDoorJson } from "./front-door.js";
import { stripHiddenCharacters, quotedCallerText } from "./hidden-chars.js";
import { RAILS_PAREN, RAILS_OR, RAILS } from "./rails.js";
import { gatewayOfferPublic, gatewayOfferNetworkNames } from "./gateway-nanopayments.js";
import { inputDepthRefusal } from "./handler-input.js";
import { runAsCallerOf } from "./dispatch-caller.js";
// The report/monitor ladder, DERIVED from the same tables that sell them.
// No cycle: report-tiers is a leaf over the kit tier tables, and neither
// checkout module imports this one.
import { reportLadderProse, agentReportPriceRange } from "./report-tiers.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
let _ladder = null;
const reportLadder = () => (_ladder ||= reportLadderProse({ humanProducts: HUMAN_PRODUCTS, monitorProducts: MONITOR_PRODUCTS }));
// A protocol error whose wire message starts "MCP error <code>: ", as SDK v1's
// McpError wrote it: every error answer the connector sends reads byte for byte
// as before on both protocol eras (clients key on the code and data).
class McpError extends ProtocolError {
  constructor(code, message, data) { super(code, `MCP error ${code}: ${message}`, data); }
}
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
//
// Protocol revisions: the MCP SDK v2 serves both eras from one server build.
// A request that carries the 2026-07-28 per-request envelope
// (_meta["io.modelcontextprotocol/protocolVersion"]) is served on the modern
// path (createMcpHandler, server/discover, no initialize); every other request
// (initialize and the 2025-era stateless calls after it, 2024-10-07 through
// 2025-11-25) is served by a per-request Node transport exactly as before.
import { AsyncLocalStorage } from "node:async_hooks";
import { Server, ProtocolError, ProtocolErrorCode as ErrorCode, createMcpHandler, isLegacyRequest, CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toWebRequest } from "@modelcontextprotocol/node";
import {
  MCP_PAYMENT_REQUIRED_CODE, MCP_PAYMENT_VERIFICATION_FAILED_CODE, MCP_RECEIPT_META, MCP_PAYMENT_REQUIRED_META, MCP_CREDENTIAL_META, credentialHeaderFromMeta, challengesFromHeader, receiptFromHeader, settleReceiptFromHeader, tempoSettleProof, credentialSignedUsd, challengeIdFromMeta,
  mcpBinaryResult,
} from "./mcp-mpp.js";
import {
  TASKS_EXTENSION, CLIENT_CAPABILITIES_META, TASK_INVALID_PARAMS, TASK_MISSING_CAPABILITY, TASK_INTERNAL_ERROR,
  mcpTasksEnabled, clientDeclaresTasks, createTaskStore, createTaskResult, detailedTask, taskAck, isTaskMethod,
} from "./mcp-tasks.js";
import { SKILLS_EXTENSION, mcpSkillsEnabled, clientDeclaresSkills, isSkillMethod, buildSkillSet, handleSkillsRpc } from "./mcp-skills.js";
import { EXPENSIVE_COMPOSITE_SLUGS, isLongRunningSlug } from "./composite-spend-guard.js";
import { registerProgressSink, throttledProgressWriter, progressView } from "./job-progress.js";
import { tempoEnabled, pushHashOf, tempoOfferedFor } from "./mpp-tempo.js";
import { isIdentityBoundRoute } from "./payments.js";
import { mppFlagshipRows, mppFlagshipOffersPhrase } from "./mpp-flagship.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { findTools, findRelatedSellers, applyFrontDoorTerms } from "./find.js";
import { buildPlanSketch } from "./plan-sketch.js";
import { partialFields, clampFields } from "./partial-answer.js";
import { boundAnswer, withAnswerBound, mcpMaxAnswerBytes } from "./mcp-answer-bound.js";
import { routableSellerSummaries, screenSellerNameOn } from "./x402-index.js";
import { logSafe } from "./log-safe.js";
import { withoutPaymentRequired } from "./payment-required-body.js";
import { recordWish } from "./wish.js";
import { capturePostHogDiscovery, capturePostHogToolGone, toolGoneSourceOf } from "./posthog.js";
import { retiredEntryForSlug } from "./retired-tools.js";
import { rankBy as rankLeaderboard } from "./leaderboard.js";
import { SKILL_PACKS, PACK_PRICE_RANGE, buildPromptMessages, rankSkillPacks } from "./skills.js";
import { withoutAttributions } from "./data-attribution.js";
import { TYPICAL_PRICE_RANGE } from "./typical-price-range.js";
import { meteredFromPrice, meteredQuoteSentence, flatTiersLine } from "./metered-lead.js";
import { leadSentence } from "./positioning.js";
import { mppMethodsSummary } from "./mpp-offers.js";
import { decideUpgradeOffer } from "./tools/decide-kit.js";
import { networkFloorUsd, ROBINHOOD_CAIP2 } from "./network-floors.js";
import { needsAsyncOrWait } from "./slow-sync-window.js";
import { PUSH_EXCEPTION } from "./tempo-push-debts.js";
import { publicPremiumClause as premiumClause } from "./public-networks.js";
import { paidPriceUsd } from "./paid-price.js";
import { creditsSalesEnabled } from "./credits-sales.js";
import { attributionOf, notCallersInput, faultAdvice } from "./tool-error-fields.js";
import { redactSecrets } from "./tools/redact.js";
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
  mcpServerDescription,
  MCP_SERVER_WEBSITE,
  mcpInstallHints,
  mcpInitializeInstructions,
  clipToolDescription,
  mcpJsonResult,
  outputSchemaFromExample,
  toolInputBoundRefusal,
  MCP_MAX_TOOL_INPUT_ELEMENTS,
} from "./mcp-flagship.js";
import {
  createLimiter,
  MAX_CALLS_PER_BURST,
  MAX_CALLS_PER_WINDOW,
} from "./rate-limit.js";
import { mcpPackageVersionFrom } from "./mcp-package-version.js";
import { decodePaymentResponseHeader } from "@x402/core/http";
import {
  readPaymentFromMeta, paymentSignatureHeader, paymentRequiredFromHeader,
  buildPaymentRequiredResult, buildInvalidPaymentResult, withPaymentResponse,
  buildSettlementPendingResult, buildSettlementUnprovenResult, buildPaidRouteFailedResult, isSettlementUndecided, jsonWithin,
} from "./mcp-x402.js";
import { maxHeaderSize } from "node:http";
import { mcpX402Entries, mcpX402PathOf, MCP_X402_PREFIX, isFixedPriceDef } from "./mcp-x402-routes.js";
import { decodesAsMppCredential, decodesAsX402Payment } from "./payment-attempt.js";

// serverInfo reports the agent402-mcp package version in the deployed build
// (mcp/package.json, which the image copies) with the server's build as
// semver build metadata: "0.13.32+build.abc1234", "+build.dev" with no commit.
// The MCP Registry lists that version once the package is published; the
// build names the deploy.
const MCP_PACKAGE_VERSION = mcpPackageVersionFrom(new URL("../mcp/package.json", import.meta.url));
const VERSION = `${MCP_PACKAGE_VERSION}+build.${(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev").slice(0, 7)}`;

// Mirrors server.js's FIND_WEAK_SCORE: an empty result set, or a top score
// below this, reads as "the catalog probably doesn't have this" — the
// trigger for the request_tool hint + a fire-and-forget find-miss wish.
// 3, not 5: a tag or slug-substring match is a SERVED query (see server.js -
// the old 5 recorded a wish for every tag-served query, a ghost cluster).
const FIND_WEAK_SCORE = 3;
// A caller-written name echoed in a refusal: quoted as a JSON string (so a
// quote in it cannot close the quote and continue as the server's own
// sentence), hidden characters removed and the length bounded.
const quotedEcho = (v, max = 80) => quotedCallerText(v, max);
const WISH_HINT_TEXT = "Nothing matched well? Tell us what you needed via POST /api/wish - we cluster demand and build what keeps coming up.";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure. Limiter implementation +
// policy live in src/rate-limit.js so the direct-HTTP PoW redemption path
// applies the same quota.
const mcpLimiter = createLimiter("mcp");
// The limiter above divides its budget among the replicas (src/rate-limit.js
// perReplica): the figure a client is told is the service-wide one, so the
// copy says so rather than quoting it as a per-replica allowance.
const RATE_LIMIT_COPY = `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client, shared across replicas`;

// Adoption telemetry: every session's initialize names its client. In memory
// since boot, one map for every mount, read on the operator surface only
// (the names are caller-chosen strings, so they never ride a public answer).
const mcpClients = new Map(); // "name@version" -> initialize count since boot
/** The clients seen since boot, most frequent first (operator surface). */
export function mcpClientsSeenSinceBoot(limit = 20) {
  return Object.fromEntries([...mcpClients].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

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
// A tools/call carrying a plausible payment (metaCarriesPayment) is counted on
// its own, larger per-IP bucket at the transport instead: a buyer paying for
// each call is not held to the free figure. Only a call that then reaches a
// paywall replay stays on it alone; any other path meets the bucket above too.
const MCP_PAID_REQ_PER_MIN = Number(process.env.AGENT402_MCP_PAID_REQ_PER_MIN) || MCP_REQ_PER_MIN * 5;
const MCP_PAID_REQ_PER_HOUR = Number(process.env.AGENT402_MCP_PAID_REQ_PER_HOUR) || MCP_REQ_PER_HOUR * 5;
const mcpPaidReqLimiter = createLimiter("mcp-transport-paid", { perMin: MCP_PAID_REQ_PER_MIN, perHour: MCP_PAID_REQ_PER_HOUR });
// How long a fixed-price PaymentRequired (a twin's first ask, a free tool's
// offer at its limit) is reused: it changes only with a price or a rail
// restored at runtime. At most OFFER_CACHE_MAX routes are kept.
const OFFER_CACHE_TTL_MS = 30_000;
const OFFER_CACHE_MAX = 256;
const reqLimitText = (path, retryAfterSeconds) => `Too many requests to ${path} - slow down and retry in about ${retryAfterSeconds} s.`;
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
export const UNPAID_CUTOFF_TEXT = "No payment was presented, so there was nothing to charge.";
/** The clause every connector "not charged" line carries: a Tempo push
 *  transfer is final before the call and a failure on it is booked as owed.
 *  Shared with the HTTP sync windows (src/tempo-push-debts.js). */
export { PUSH_EXCEPTION };
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

/** The text of an error this connector answers with: a configured secret
 *  value or a credential-bearing URL it quotes (an upstream echo, a database
 *  driver's connection string) is scrubbed BEFORE the cut, so a cut never
 *  splits a secret past the scrubber; the rest of the reason stays readable.
 *  With no `max` the whole scrubbed text is kept.
 *  The HTTP route binder answers the same scrubbed text. */
export function mcpErrorText(err, max = undefined) {
  const raw = err && typeof err === "object" && "message" in err ? err.message : err;
  return redactSecrets(String(raw ?? "")).slice(0, max);
}

/** The tool-result text for a call this connector stopped waiting on.
 *  `paid` = a payment credential rode along on the call; only without one is
 *  "nothing was charged" certain. */
export function connectorCutoffText({ label, seconds, paid, route = null, error = null }) {
  // The unpaid text's "nothing to charge" holds only because no credential
  // was presented; a paid cut-off never says it.
  const money = paid ? PAID_CUTOFF_TEXT : UNPAID_CUTOFF_TEXT;
  const where = route ? `${route} over HTTP` : "the tool's HTTP route directly";
  if (error != null) return `${label}: the call could not be completed (${mcpErrorText(error, 120)}). ${money}${paid ? "" : " Retry shortly."}`;
  return `${label}: the call did not finish within ${seconds}s on this connector and the connector stopped waiting. ${money} ${paid ? "For long calls, use" : "Retry, or call"} ${where}, which has no connector deadline.`;
}
// How long a task-eligible composite may run before we answer with a task
// handle instead of blocking. Sized well under MCP_REQ_DEADLINE_MS so the
// synchronous answer always fits, and well over the time a paywall needs to
// decide a 402 (which is settled before the handler runs).
const TASK_GATE_MS = Number(process.env.AGENT402_MCP_TASK_GATE_MS) || 8_000;
/** tasks/get _meta key for a task's progress view (src/job-progress.js). */
export const TASK_PROGRESS_META = "org.agent402/progress";
let mcpInFlight = 0;

/** The largest MPP credential a call can carry plausibly: it is replayed to
 *  the MPP gate as its Authorization header, and the gate's HTTP parser takes
 *  no header block past this, so a larger one could never be verified. */
export const MPP_CREDENTIAL_MAX_BYTES = maxHeaderSize;

/** True when a call's _meta holds a PLAUSIBLE payment, read the way the HTTP
 *  limiters read a payment header (src/payment-attempt.js, the rule
 *  looksLikePayment applies): an MPP credential that decodes, no larger than
 *  MPP_CREDENTIAL_MAX_BYTES, or an x402
 *  payment the reader accepts whose network this server offers. When an MPP
 *  credential rides along it alone decides (the dispatch uses MPP then).
 *  Shape, not validity: the paywall verifies. Never throws. */
export function metaCarriesPayment(meta) {
  try {
    if (!meta || typeof meta !== "object") return false;
    // Its size first: nothing past the gate's header limit is serialized or decoded.
    const rawCred = meta[MCP_CREDENTIAL_META];
    if (rawCred && (typeof rawCred === "string" ? rawCred.length > MPP_CREDENTIAL_MAX_BYTES : !jsonWithin(rawCred, MPP_CREDENTIAL_MAX_BYTES))) return false;
    const cred = credentialHeaderFromMeta(meta);
    if (cred) return cred.length <= MPP_CREDENTIAL_MAX_BYTES && decodesAsMppCredential(cred);
    const read = readPaymentFromMeta(meta);
    return read.ok === true && !!read.payment && decodesAsX402Payment(paymentSignatureHeader(read.payment));
  } catch { return false; }
}

/** True for a tools/call whose _meta carries a plausible payment
 *  (metaCarriesPayment). Such a request is held to the payment limit at the
 *  transport, and to the normal limit too unless its call reaches a paywall
 *  replay (see the CallTool handler). Never throws. */
export function carriesPayment(body) {
  try {
    if (!body || typeof body !== "object" || body.method !== "tools/call") return false;
    return metaCarriesPayment(body.params?._meta);
  } catch { return false; }
}

/**
 * Mount the MCP endpoint on the express app.
 * `catalog` is the CATALOG map (route -> tool def), `opts.isComputePayable`
 * decides the free set. `opts.onServed(slug, { latencyMs, errored })` feeds
 * both the stats counters and the analytics dashboard with full per-call meta
 * for the free path. `opts.onPaidCutoff(slug, { statusCode, errorMessage,
 * latencyMs, heartbeatToken })` books the one paid outcome no route sees: a
 * loopback that returned no answer (timed out, failed, or a task run that
 * was aborted); every answered paid call is booked by the route it reached.
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
/** The headers the SDK's era classification reads, on a body-less Request:
 *  isLegacyRequest(probe, parsedBody) classifies from the parsed body and
 *  these headers and reads nothing else, so the request body is never
 *  re-serialized for a 2025-era call. */
const ERA_HEADERS = ["content-type", "mcp-protocol-version", "mcp-method", "mcp-name"];
export function eraProbeOf(req) {
  const headers = new Headers();
  for (const h of ERA_HEADERS) {
    const v = req.headers?.[h];
    if (typeof v === "string") { try { headers.set(h, v); } catch { /* an unsendable value classifies as absent */ } }
  }
  return new Request("http://mcp.invalid/", { method: "POST", headers });
}

/** Writes a web-standard Response from the 2026-07-28 handler to Express. A
 *  JSON answer is read whole first, then written in one go unless the request
 *  was aborted or answered meanwhile (the deadline writes its own result); an
 *  event stream (subscriptions/listen) is piped until it ends or the request
 *  is aborted. */
export async function writeWebResponse(res, response, signal) {
  const isStream = /^text\/event-stream/i.test(response.headers.get("content-type") || "");
  const writeHead = () => {
    res.status(response.status);
    for (const [k, v] of response.headers) res.setHeader(k, v);
  };
  if (!response.body) {
    if (!res.headersSent && !signal.aborted) { writeHead(); res.end(); }
    return;
  }
  if (!isStream) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (res.headersSent || signal.aborted) return;
    writeHead();
    res.end(buf);
    return;
  }
  if (res.headersSent || signal.aborted) { try { await response.body.cancel(); } catch { /* already closed */ } return; }
  writeHead();
  res.flushHeaders?.();
  const reader = response.body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      if (value && !res.write(value)) await new Promise((r) => { res.once("drain", r); signal.addEventListener("abort", r, { once: true }); });
    }
  } catch { /* the stream was canceled */ } finally {
    signal.removeEventListener("abort", stop);
    if (!res.writableEnded) res.end();
  }
}

export function _sharedTaskStoreForTest() { return sharedTaskStore; }
/** The MPP methods the hosted connector can settle a paid tool call with. */
export function mcpPaymentMethods() {
  return {
    evm: { intents: ["charge"] },
    ...(tempoEnabled() ? { tempo: { intents: ["charge"] } } : {}),
    ...(stripeEnabled() ? { stripe: { intents: ["charge"] } } : {}),
  };
}

export function mountMcp(app, catalog, { baseUrl, isComputePayable, onServed = () => {}, onPaidCutoff = () => {}, getLeaderboard = null, getMppLeaderboard = null, mppLoopback = null, x402Loopback = null, payWires = null, decideFeedback = null, taskStore = null, taskStoreDir = null, path = "/mcp", profile = null, maxToolInputElements = MCP_MAX_TOOL_INPUT_ELEMENTS, offerCacheMax = OFFER_CACHE_MAX }) {
  // The wires this mount takes in the call. `payWires` is the boot's own
  // account (src/connector-pay.js connectorWires, the source the pages read):
  // a wire it denies has no loopback here, so the capability advertisement,
  // the gates, the tasks path and the copy all read one answer. A FREE_MODE
  // boot with MPP_SECRET_KEY set takes no MPP credential anywhere.
  if (payWires?.mpp === false) mppLoopback = null;
  if (payWires?.x402 === false) x402Loopback = null;
  // sellers.list is listed and answered only when the connector opts in (AGENT402_SHOW_ROUTER=1).
  const sellersListed = Boolean(getLeaderboard) && process.env.AGENT402_SHOW_ROUTER === "1";
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
  // Prices quoted in this connector's prose, read from the catalog it serves.
  const fmtUsd = (n) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
  const priceText = (slug) => { const n = toolPriceUsd(slug); return n == null ? null : fmtUsd(n); };
  const gatewayTierUsd = [...packPriceIndex.entries()].filter(([slug]) => /^v1-(chat|embeddings)/.test(slug) && !/metered/.test(slug)).map(([, n]) => n).filter((n) => n > 0);
  const gatewayRange = gatewayTierUsd.length ? `${fmtUsd(Math.min(...gatewayTierUsd))}–${fmtUsd(Math.max(...gatewayTierUsd))}` : null;
  const gatewayFlat = [["chat nano", priceText("v1-chat-nano")], ["auto (eval-ranked model routing)", priceText("v1-chat-auto")], ["embeddings", priceText("v1-embeddings")]].filter(([, p]) => p).map(([k, p]) => `${k} ${p}`).join(", ");
  // Chains the agent402-mcp npm server resolves by name in AGENT402_NETWORKS
  // (mcp/networks.js, every rail since 0.13.25, pinned by test-legal-claims.js);
  // a CAIP-2 id works on every published version. Arc is shown by its CAIP-2
  // id so the setup line works on versions before 0.13.25 too.
  const NPM_EVM_PRESETS = { base: "Base", polygon: "Polygon", arbitrum: "Arbitrum", monad: "Monad", celo: "Celo", avalanche: "Avalanche", sei: "Sei", optimism: "Optimism", robinhood: "Robinhood Chain", arc: "Arc", ink: "Ink" };
  const SETUP_NAMED = ["Base", "Polygon", "Arbitrum", "Robinhood Chain", "Arc"];
  const presetOf = (name) => Object.keys(NPM_EVM_PRESETS).find((k) => NPM_EVM_PRESETS[k] === name);
  const otherEvm = RAILS.filter((r) => r.chainId && !SETUP_NAMED.includes(r.name)).map((r) => (presetOf(r.name) ? `${presetOf(r.name)} (${r.caip2})` : `${r.name} ${r.caip2}`));
  const npmEvmSetup = `Use a new wallet holding only a few dollars of USDC. Never your main wallet. AGENT_KEY=0x<private key> for EVM (USDC on Base, Polygon or Arbitrum; USDG on Robinhood Chain via AGENT402_NETWORKS=robinhood; USDC on Arc via AGENT402_NETWORKS=eip155:5042${otherEvm.length ? `; any other EVM rail by name or CAIP-2 id in AGENT402_NETWORKS: ${otherEvm.join(", ")}` : ""})`;
  // MPP start-here set (src/mpp-flagship.js) as served by this connector's
  // catalog, prices read from it. Surfaced in payment.info.
  const mppStartHere = mppFlagshipRows(catalog).map((r) => ({ slug: r.slug, method: r.method, path: r.path, url: `${baseUrl}${r.path}`, price: r.price, why: r.why }));
  const tools = new Map(); // slug -> { def, free }
  for (const def of Object.values(catalog)) {
    tools.set(def.slug, { def, free: isComputePayable(def) });
  }
  const freeCount = [...tools.values()].filter((t) => t.free).length;
  const freeSlugs = new Set([...tools.entries()].filter(([, t]) => t.free).map(([slug]) => slug));

  // Skills over MCP (io.modelcontextprotocol/skills, src/mcp-skills.js): each
  // skill pack served as an Agent Skill. Armed by MCP_SKILLS=on, and only on a
  // mount that lists catalog.call, the call every skill body names.
  const skillSet = mcpSkillsEnabled() && !scoped
    ? buildSkillSet({ freeSlugs, priceOf: (slug) => tools.get(slug)?.def?.price ?? null, toolOf: (slug) => tools.get(slug)?.def ?? null })
    : null;

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

  // The x402 MCP wire (src/mcp-x402.js): a flagship called by its listed name
  // is paid on its internal twin (src/mcp-x402-routes.js: resource /mcp, an
  // MCP discovery extension); catalog.call, and a flagship with no twin on
  // this boot, is paid on the slug's own HTTP route and challenge. Either way
  // the loopback carries the payment as PAYMENT-SIGNATURE and the route's x402
  // paywall verifies, runs and settles it (settle after a <400 answer only).
  // Fixed-price unpaid offers (x402Offer): the twins', and a free tool's at
  // its limit. One entry per route, `offerCacheMax` routes at most.
  const offerCache = new Map();
  const x402TwinSlugs = new Set(x402Loopback ? mcpX402Entries(catalog).map((e) => e.slug) : []);
  // The wires a paid tool is payable over in the call on this mount, for the
  // listed descriptions: "x402 or MPP", "x402", "MPP" or "".
  // Every text this connector writes about paying in the call reads these
  // two; a wire `payWires` denies has no loopback (top of this function).
  const payX402 = Boolean(x402Loopback);
  const payMpp = Boolean(mppLoopback);
  const inCallWires = [payX402 && "x402", payMpp && "MPP"].filter(Boolean).join(" or ");
  // What a tool whose run outlasts the blocking wait takes: the x402 wire is
  // blocking only, so a long call is paid in the call over MPP (as a task).
  /** True when this tool's run can outlast the blocking wait: the x402 wire
   *  refuses its signed retry (payOverX402), so no x402 offer is made for it. */
  const isLongCall = (def) => needsAsyncOrWait(def?.asyncProfile, PAID_LOOPBACK_TIMEOUT_MS / 1000);
  const longCallNote = payX402
    ? `a tool whose run can outlast this connector's blocking wait (${Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000)} s) is not paid here over x402: ${payMpp ? "pay it here over MPP as an MCP task, or call" : "call"} its HTTP route with Prefer: respond-async`
    : "";
  /** The route an x402 payment for this call is replayed to. */
  const x402TargetOf = (def, isNamed) => {
    if (!isNamed || !x402TwinSlugs.has(def.slug) || !flagshipSet.has(def.slug)) return def;
    const method = String(def.route || "POST /").split(" ")[0];
    return { ...def, route: `${method} ${mcpX402PathOf(def.slug)}` };
  };

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
    const q = withoutAttributions(String(query || ""));
    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    applyFrontDoorTerms(terms, q);
    const scored = [];
    for (const { def, free } of tools.values()) {
      const slug = def.slug.toLowerCase();
      const tagSet = new Set((def.tags || []).map((tg) => String(tg).toLowerCase()));
      const hay = `${def.name} ${withoutAttributions(def.description)} ${def.category} ${(def.tags || []).join(" ")}`.toLowerCase();
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
    // Clamped at both ends: a negative count would read as "all but the last n".
    const rows = scored.slice(0, Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), SEARCH_LIMIT_MAX)).map(([, def, free]) => ({
      slug: def.slug,
      price: def.price,
      access: free ? "free here (rate-limited)" : "paid (USDC via x402 / MPP - agent402-mcp with AGENT_KEY, or a prepaid credits key already issued as AGENT402_CREDITS_KEY)",
      description: def.description.length > 200 ? `${def.description.slice(0, 200)}…` : def.description,
      inputSchema: schemaOf(def),
    }));
    return { rows, topScore: scored[0]?.[0] ?? 0, matched: scored.length };
  }

  // `x402`: the result this text rides on carries an x402 PaymentRequired;
  // `mpp`: it carries MPP challenges. Each names only the wires on offer.
  // A long call (isLongCall) is never invited to sign an x402 payment: it is
  // paid here over MPP as a task, or on its HTTP route as a job.
  function walletRequiredText(def, { x402 = false, mpp = payMpp } = {}) {
    const lead = `This tool requires payment; see payment.info. "${def.slug}" (${def.price}/call) is not part of this hosted free tier.`;
    if (isLongCall(def)) {
      const asTask = mpp && Boolean(tasks);
      return [
        lead,
        `It can run up to ${Number(def.asyncProfile?.maxSeconds)} s, longer than this connector's blocking wait (${Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000)} s)${payX402 ? ", so it is not paid here over x402" : ""}.`,
        ...(asTask ? [`Pay it RIGHT HERE over MPP as an MCP task: call again declaring the MCP tasks extension on the request (_meta["${CLIENT_CAPABILITIES_META}"].extensions["${TASKS_EXTENSION}"]) with an MPP credential in _meta["org.paymentauth/credential"], and the run is handed back as a task handle to poll.`] : []),
        `${asTask ? "Or call" : "Call"} its HTTP route ${def.route} with the header Prefer: respond-async and any x402 client: it answers 202 with a job link.`,
        `Or run the npm server with a funded wallet: npx agent402-mcp with env ${npmEvmSetup}. Docs: ${baseUrl}/tools/${def.slug}`,
      ].join(" ");
    }
    const here = x402 || mpp;
    return [
      lead,
      ...(x402 ? [`Pay it RIGHT HERE over x402: sign one of the accepts in this result's PaymentRequired (the JSON in its first text block) and call again with the payment in _meta["x402/payment"] - an x402 MCP client does this automatically; the settle receipt comes back in _meta["x402/payment-response"].`] : []),
      ...(mpp ? [`${x402 ? "Or pay it here" : "Pay it RIGHT HERE"} over MPP: call again with an MPP credential in _meta["org.paymentauth/credential"] - mppx's McpClient.wrap() does this automatically (USDC on Base/Celo via evm.charge, or native Tempo via tempo.charge); the receipt comes back in _meta["org.paymentauth/receipt"].`] : []),
      `${here ? "Or, from" : "To pay it from"} Claude or any MCP client, run the npm server with a funded wallet:`,
      `npx agent402-mcp with env ${npmEvmSetup} and/or SOLANA_AGENT_KEY=<base58 secret> (USDC on Solana); spend caps: AGENT402_MAX_PER_CALL, AGENT402_BUDGET.`,
      `Or call it over HTTP with any x402 client. Docs: ${baseUrl}/tools/${def.slug}`,
    ].join(" ");
  }

  // `skillsCaps`: the skills capability is on THIS server instance. True for an
  // initialize whose client declared the extension (the only answer that
  // shows capabilities), and for every other request while skills are armed,
  // so resources/list and resources/read are answered for a client that saw
  // the declaration on its own initialize.
  /** The catalog entry a tools/call names: a flagship by any of its
   *  spellings, or catalog.call's slug. The dispatch and the payment-limit
   *  test below both read it, so they cannot disagree on the target. */
  function callTargetOf(name, args) {
    const namedSlug = namedToolSlugs.get(name) ?? namedToolSlugs.get(String(name).replace(/_/g, "-")) ?? null;
    const isNamed = namedSlug !== null;
    if (name !== "catalog.call" && !isNamed) return { isNamed, resolvedSlug: null, entry: null };
    const resolvedSlug = isNamed ? namedSlug : String(args?.slug ?? "");
    return { isNamed, resolvedSlug, entry: tools.get(resolvedSlug) || null };
  }

  // The names the CallTool handler answers before it resolves a target.
  const answeredBeforeTarget = (name, args) => (scoped && HIDDEN_WHEN_SCOPED.has(name))
    || ["catalog.search", "catalog.find", "demand.request", "server.describe", "payment.info"].includes(name)
    || (name === "decide.feedback" && Boolean(decideFeedback))
    || (name === "sellers.list" && sellersListed);

  /** True when this call is replayed to a paywall with the payment in its
   *  _meta (payOverMpp or payOverX402 below) and that payment is plausible
   *  (metaCarriesPayment): an MPP credential on a paid tool while the MPP
   *  gates are mounted, or, with no MPP credential, an x402 payment on any
   *  tool while the x402 wire is on. Never throws. */
  function reachesPaidReplay(name, args, meta) {
    try {
      if (answeredBeforeTarget(name, args) || !metaCarriesPayment(meta)) return false;
      const { entry } = callTargetOf(name, args);
      if (!entry) return false;
      if (credentialHeaderFromMeta(meta)) return Boolean(mppLoopback) && !entry.free;
      return Boolean(x402Loopback);
    } catch { return false; }
  }

  // `declaredCapabilities`: the client capabilities THIS request declared in
  // _meta["io.modelcontextprotocol/clientCapabilities"], read from the raw
  // body. The SDK lifts that key out of params._meta before a handler runs (on
  // both eras), so the tasks check reads it from here.
  function buildServer(ip, signal, heartbeatToken = null, { skillsCaps = false, reqHeaders = {}, paymentCall = false, declaredCapabilities = undefined } = {}) {
    const server = new Server(
      {
        name: profile?.serverName || "agent402",
        version: VERSION,
        title: "Agent402",
        description: mcpServerDescription({ mpp: payWires ? Boolean(payWires.mpp) : mppMethodsSummary().enabled }),
        websiteUrl: baseUrl || MCP_SERVER_WEBSITE,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          // The skills extension requires the base resources capability.
          ...(skillsCaps ? { resources: {} } : {}),
          // MCP Tasks extension (io.modelcontextprotocol/tasks). The 2026-07-28
          // spec has servers advertise extensions in the capabilities returned
          // by `server/discover`; this connector still speaks the initialize
          // handshake, so the same capabilities object is where it goes. Only
          // advertised when the extension is armed AND paid calls are actually
          // possible here - a task only exists to carry a PAID composite run.
          ...((tasks || skillsCaps) ? { extensions: { ...(tasks ? { [TASKS_EXTENSION]: {} } : {}), ...(skillsCaps ? { [SKILLS_EXTENSION]: {} } : {}) } } : {}),
          // MPP transport-mcp "MCP Capability Advertisement": the methods a
          // paid tool call here can be settled with, read from the gates that
          // are actually live. Only when the MPP loopback exists - without it a
          // paid call here cannot be settled at all.
          ...(mppLoopback ? { experimental: { payment: { methods: mcpPaymentMethods() } } } : {}),
        },
        instructions: profile?.instructions || mcpInitializeInstructions(baseUrl, { decide: !!catalog["POST /api/decide"], mpp: payMpp, x402: payX402, mppOffered: payWires ? Boolean(payWires.mpp) : mppMethodsSummary().enabled }),
      },
    );

    // Skill packs are exposed as MCP prompts: each pack becomes a discoverable
    // prompt the client can render in a slash menu (Claude Desktop, Cursor,
    // etc.). The pack data lives in src/skills.js — same source of truth as
    // the HTML pages at /skills/<slug>. buildPromptMessages does the args
    // substitution + tool-plan rendering, and gets freeSlugs so it can pre-
    // split free vs wallet-only tools for the caller.
    server.setRequestHandler("prompts/list", async () => ({
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
    server.setRequestHandler("prompts/get", async (req) => {
      const { name, arguments: args = {} } = req.params;
      const pack = SKILL_PACKS.find((p) => p.slug === name);
      if (!pack) throw new Error(`Unknown prompt ${quotedEcho(name)}. List available with prompts/list.`);
      return buildPromptMessages(pack, args, { freeSlugs });
    });

    // Skill files as base resources (src/mcp-skills.js). skills/list and
    // skills/get are answered ahead of the transport, in app.post below.
    if (skillsCaps && skillSet) {
      server.setRequestHandler("resources/list", async (req) => {
        if (req.params?.cursor != null) throw new McpError(ErrorCode.InvalidParams, "Invalid cursor");
        return {
          resources: [...skillSet.fileByUri.values()].map(({ uri, name, title, description, mimeType, size }) => ({ uri, name, title, description, mimeType, size })),
        };
      });
      server.setRequestHandler("resources/read", async (req) => {
        const uri = String(req.params?.uri || "");
        const file = skillSet.fileByUri.get(uri);
        if (!file) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri.slice(0, 200)}`);
        return { contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] };
      });
    }

    // Titles + safety annotations on every tool are required for listing in
    // Anthropic's connector directory. A host may run a read-only tool without
    // asking its user, so readOnlyHint is true only for a tool that can never
    // charge and never writes on any path here: the catalog lookups, the
    // leaderboard read, describe and payment info. Every tool that can charge
    // (each flagship, catalog.call) or leaves something behind is not.
    const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const CALL_PAID = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    // A flagship reaches the network and can charge: not read-only, open-world.
    const NET = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    // memory.write replaces the value a key held.
    const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    const flagshipHints = (slug) => (slug === "memory-write" ? OVERWRITE : NET);
    server.setRequestHandler("tools/list", async () => ({
      tools: listable([
        {
          name: META_MCP_NAMES.search_tools,
          title: "Search the Agent402 tool catalog",
          annotations: { title: "Search the Agent402 tool catalog", ...SAFE },
          description:
            `Keyword search over the Agent402 catalog of 500+ tools (${tools.size} loaded by this connector). Returns { results, workflows }; run one with catalog.call. ${freeCount} pure-CPU tools run free here (proof-of-work). The others are paid per call${inCallWires ? `, payable here in the call over ${inCallWires} (the payment rides in _meta), or through` : ", through"} npx agent402-mcp with a wallet.`,
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
            "Resolve a plain-language task to the single best-matching Agent402 tool, returned call-ready: slug, price, input schema and a worked example. Use catalog.search to compare several candidates. Returns { task, results } with the top pick first; run it with catalog.call and the slug and params it lists.",
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
          // Honest hints, read from what this connector can do. Without MPP it
          // runs only the pure-CPU tools (no egress, no state, no spend), which
          // is read-only and closed-world. With MPP a call can carry a payment
          // and run any slug, including ones that write or delete wallet-keyed
          // memory, attest on-chain or buy from another seller, so it is
          // neither read-only nor idempotent, can be destructive, and reaches
          // the outside world. Hosts read readOnlyHint to skip confirmation.
          annotations: { title: "Run an Agent402 tool", ...CALL_PAID },
          description:
            `Run an Agent402 tool by slug, with params matching that tool's inputSchema; find slugs with catalog.find or catalog.search. The ${freeCount} pure-CPU tools run free here, rate-limited, through proof-of-work. ${inCallWires ? `Paid tools are payable here, in the call, over ${inCallWires} (the first answer carries the ask).` : "A paid tool answers with payment setup; see payment.info."} An unknown slug returns an error.`,
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
            `How paying for Agent402 tools works. This connector holds no wallet: ${freeCount} pure-CPU tools run free through proof-of-work, and the rest settle in USDC over x402${payMpp ? " or MPP" : ""}${inCallWires ? ` (payable here, in the call, over ${inCallWires})` : ""}. Covers wallet setup, per-call and session spend caps, the payment rails, and checking a wallet's balance. Returns { connector, freeTier, pay, spendControls, balanceAndHistory }.`,
          inputSchema: { type: "object", properties: {} },
          outputSchema: META_OUTPUT_SCHEMAS["payment.info"],
        },
        // Flagship demand tools — listed first-class so agents see search/answer
        // as the front door without a discovery round-trip. Wallet-only on this
        // authless connector: calling returns paid-access setup.
        ...[...flagshipSet].map((slug) => {
          const { def, free } = tools.get(slug);
          const ann = flagshipHints(slug);
          const access = free
            ? "[free, no wallet]"
            : `Paid (${def.price}/call):`;
          const walletNote = free
            ? ""
            : ` This hosted connector holds no wallet: ${inCallWires ? `pay it here, in the call, over ${inCallWires}, or ` : ""}run npx agent402-mcp with a funded wallet (AGENT_KEY) or a prepaid credits key already issued (AGENT402_CREDITS_KEY), or any x402 client.`;
          const outSchema = FLAGSHIP_OUTPUT_SCHEMAS[slug]
            || outputSchemaFromExample(def.discovery?.output?.example);
          return {
            name: mcpNameOf(slug),
            title: def.name,
            annotations: { title: def.name, ...ann },
            description: clipToolDescription(`${access} ${def.description}${returnsHint(def)}${walletNote}`),
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
            openWorldHint: true,
          },
          description: `[free] Report a capability the 500+ tools do not cover, after catalog.search or catalog.find found nothing that fits. Requests are clustered by need, and frequent ones get built. Records demand only: it runs nothing. Same intake as POST ${baseUrl}/api/wish; aggregate demand is public at ${baseUrl}/api/wishes.`,
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
          description: "[free] Describe this connector: the tools it lists, how to install (Claude Code / Cursor / npm), free vs paid tiers, and discovery URLs.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: META_OUTPUT_SCHEMAS["server.describe"],
        },
        ...(decideFeedback ? [{
          name: "decide.feedback",
          title: "Report how a decide plan step went",
          annotations: { title: "Report how a decide plan step went", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        ...(sellersListed ? [{
          // Dotted Smithery Naming (sellers.list). Prior snake/digit names
          // remain CallTool aliases via resolveListedName.
          name: META_MCP_NAMES.list_top_sellers,
          title: "List top x402 sellers",
          annotations: { title: "List top x402 sellers", ...OPEN },
          description: "[free] List ranked sellers from the on-chain settlement leaderboards. wire=x402 (default): x402 sellers by settled calls, USDC totals and distinct buyers. wire=mpp: MPP sellers ranked by inbound USDC.e transfers on Tempo. This host's own wallet is excluded unless include is all.",
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

      // The composites, plus every route that runs as a job over HTTP
      // (src/slow-routes.js: the slow ones and the async-capable ones).
      const taskEligible = Boolean(tasks) && (EXPENSIVE_COMPOSITE_SLUGS.has(entry.def.slug) || Boolean(entry.def.asyncProfile)) && clientDeclaresTasks({ _meta: { [CLIENT_CAPABILITIES_META]: declaredCapabilities } });
      if (taskEligible) {
        const handle = await runAsTask(entry, meta, params, credentialHeader, ip, isNamed, startedAt, idempotencyKey);
        if (handle) return handle;
        // Fell through: the run finished (or was refused) inside the gate window,
        // so answer synchronously exactly as a blocking call would.
      } else if (credentialHeader && !pushHashOf(credentialHeader) && needsAsyncOrWait(entry.def.asyncProfile, PAID_LOOPBACK_TIMEOUT_MS / 1000)) {
        // A paid run whose budget outlasts this connector's blocking wait
        // cannot be served blocking: the loopback would be cut after the gate
        // passed, the run would settle, and the answer would be owed. The HTTP
        // route refuses the same shape before any gate
        // (src/slow-sync-window.js); so does this, before the loopback, for a
        // client that did not declare the tasks extension on this request.
        // An unpaid call still gets its 402 from the loopback. A Tempo PUSH
        // credential names a transfer that is already final on chain:
        // refused here it would stay unclaimed and unbooked, so it goes to
        // the loopback, where the gate claims it and an answer this
        // connector stops waiting for is booked as owed by the route
        // (src/hangup-settlement.js).
        return { content: [{ type: "text", text: slowCallRefusalText(entry.def) }], isError: true };
      }

      // The paid loopback must end BEFORE this connector's own request
      // deadline. When the deadline won, the transport answered a JSON-RPC
      // -32603 that MCP hosts render as a bare "Error occurred during tool
      // execution", and the loopback was cut mid-flight. Bounded here, the
      // caller gets a tool result naming what happened instead.
      // A first ask offers the x402 wire beside MPP: a flagship's twin is
      // asked in parallel (its PaymentRequired names resource /mcp); any
      // other slug's offer is the PAYMENT-REQUIRED header of the same 402.
      // A long call gets no x402 offer: its signed retry would be refused.
      const x402Target = !credentialHeader && x402Loopback && !isLongCall(entry.def) ? x402TargetOf(entry.def, isNamed) : null;
      const twinAsk = x402Target && x402Target !== entry.def ? x402Offer(x402Target, params, ip, signal) : null;
      let r;
      try {
        r = await mppLoopback({ def: entry.def, params, credentialHeader, ip, signal, idempotencyKey, timeoutMs: PAID_LOOPBACK_TIMEOUT_MS, heartbeatToken });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        console.warn(`[mcp] tools/call failed class=${timedOut ? "paid-timeout" : "paid-loopback-error"} tool=${entry.def.slug} after=${Date.now() - startedAt}ms`);
        // The loopback returned no answer, so no route booked this outcome:
        // the connector books it (the one failure class that is its own).
        onPaidCutoff(entry.def.slug, { statusCode: timedOut ? 504 : 502, errorMessage: timedOut ? "paid loopback timed out" : "paid loopback failed", latencyMs: Date.now() - startedAt, heartbeatToken });
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
      const x402Required = x402Target && r.status === 402
        ? (twinAsk ? await twinAsk : paymentRequiredFromHeader(r.headers.get("payment-required")))
        : null;
      return translateMppResponse(entry, meta, params, startedAt, isNamed, r, { x402Required });
    }

    /** The params a paid call replays (flagship: args IS params; catalog.call:
     *  the {slug, params} envelope, a JSON string or flattened). */
    function paidParamsOf(args, isNamed) {
      let params = isNamed ? args : args?.params;
      if (typeof params === "string") { try { params = JSON.parse(params); } catch { params = {}; } }
      if (!params || typeof params !== "object" || Array.isArray(params)) { const { slug: _drop, ...rest } = args || {}; params = rest && Object.keys(rest).length ? rest : {}; }
      return params;
    }

    /** The x402 PaymentRequired a route answers an unpaid call with (its
     *  PAYMENT-REQUIRED header), read over the loopback; null when the route
     *  answers anything else or the read fails. Never throws. */
    async function x402Offer(def, params, ip, signal, { reuse = false } = {}) {
      if (!x402Loopback) return null;
      // A twin's offer is fixed-price and the same for every caller, and so is
      // a fixed-price free tool's at its limit (`reuse`): each is kept per
      // route for OFFER_CACHE_TTL_MS, so a flagship's first ask costs one
      // loopback (the MPP ask), not two, and a client calling past its limit
      // costs no loopback per call. A priced-per-request route is never kept.
      const cacheable = (String(def.route || "").includes(MCP_X402_PREFIX) || reuse) && isFixedPriceDef(def);
      const hit = cacheable ? offerCache.get(def.route) : null;
      if (hit && Date.now() - hit.at < OFFER_CACHE_TTL_MS) return structuredClone(hit.offer);
      if (hit) offerCache.delete(def.route);
      try {
        const r = await x402Loopback({ def, params, ip, signal, timeoutMs: PAID_LOOPBACK_TIMEOUT_MS, heartbeatToken });
        const offer = r.status === 402 ? paymentRequiredFromHeader(r.headers.get("payment-required")) : null;
        if (cacheable && offer) {
          // Bounded: the oldest entry goes first.
          if (offerCache.size >= offerCacheMax) offerCache.delete(offerCache.keys().next().value);
          offerCache.set(def.route, { at: Date.now(), offer: structuredClone(offer) });
        }
        return offer;
      } catch { return null; }
    }

    /** A paid call over the x402 MCP wire: the payment read from
     *  _meta["x402/payment"] is replayed as PAYMENT-SIGNATURE to the route
     *  that prices it (x402TargetOf), which verifies, runs the handler and
     *  settles only a <400 answer. Blocking only: no task, no respond-async.
     *  `read` is readPaymentFromMeta's answer (a refusal, or a payment). */
    async function payOverX402(entry, reqParams, args, isNamed, ip, signal, read) {
      const def = entry.def;
      const target = x402TargetOf(def, isNamed);
      const params = paidParamsOf(args, isNamed);
      const startedAt = Date.now();
      // A long call first, whatever the payment reads as: it is never paid
      // here over x402, so no answer to it carries an offer to sign.
      if (needsAsyncOrWait(def.asyncProfile, PAID_LOOPBACK_TIMEOUT_MS / 1000)) {
        const budget = Number(def.asyncProfile?.maxSeconds);
        return { content: [{ type: "text", text: `respond_async_required: ${def.slug} can take up to ${budget} s, longer than this connector waits for a call paid over x402 (${Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000)} s). Call the HTTP route ${def.route} with the header Prefer: respond-async, which answers 202 with a job link. This call was refused before the payment was presented, so nothing was charged.` }], isError: true };
      }
      if (!read.ok) {
        // The payment cannot be used: nothing was sent to any paywall.
        const offer = await x402Offer(target, params, ip, signal);
        return (offer && buildInvalidPaymentResult(offer, { reason: read.reason, message: read.message }))
          || { content: [{ type: "text", text: `Agent402 (${def.slug}): ${read.message} - not charged.` }], isError: true };
      }
      const paymentSignature = paymentSignatureHeader(read.payment);
      const idempotencyKey = reqParams?._meta?.["org.agent402/idempotency-key"];
      let r;
      try {
        r = await x402Loopback({ def: target, params, paymentSignature, ip, signal, idempotencyKey, timeoutMs: PAID_LOOPBACK_TIMEOUT_MS, heartbeatToken });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        console.warn(`[mcp] tools/call failed class=${timedOut ? "paid-timeout" : "paid-loopback-error"} wire=x402 tool=${def.slug} after=${Date.now() - startedAt}ms`);
        onPaidCutoff(def.slug, { statusCode: timedOut ? 504 : 502, errorMessage: timedOut ? "paid loopback timed out" : "paid loopback failed", latencyMs: Date.now() - startedAt, heartbeatToken });
        return {
          content: [{ type: "text", text: connectorCutoffText({
            label: `Agent402 (${def.slug})`, seconds: Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000), paid: true,
            route: def.route, error: timedOut ? null : (err?.message || err),
          }) }],
          isError: true,
        };
      }
      return translateX402Response(entry, target, params, isNamed, r, ip, signal);
    }

    /** The no-offer result for a paid loopback's 402 that records a failed
     *  settle: ANY settle receipt marked success: false, or the paywall's
     *  bare settlement_failed body with no receipt and no offer of its own.
     *  The receipt is one facilitator's answer; it does not say how a settle
     *  fallback asked after it ended (a 5xx, a reset, a failure naming a
     *  transaction), so no receipt here proves that nothing was sent, and
     *  nothing here may be signed again, whatever offer the 402 carries. A
     *  buyer who wants to try again starts a new call. null for every other
     *  answer (a verify refusal carries no receipt and keeps its offer).
     *  `settle` is the decoded PAYMENT-RESPONSE (or null), `body` the 402's
     *  JSON body. */
    function failedSettleResult(def, r, body, settle) {
      const failed = Boolean(settle) && typeof settle === "object" && settle.success === false;
      const bare = !settle && !r.headers.get("payment-required") && body?.error === "settlement_failed";
      if (!failed && !bare) return null;
      // A settle chain the route answered as not confirmed (retry
      // watch-transaction or check-wallet): the transfer may still land, so
      // it is the pending result with the route's verb and expiry, never
      // "did not settle".
      if (isSettlementUndecided(body, null) && body?.reason === "settlement-unconfirmed") {
        return buildSettlementPendingResult({ label: `Agent402 (${def.slug})`, refusal: body, retryAfterSeconds: r.headers.get("retry-after"), settleResponse: failed ? settle : null });
      }
      return buildSettlementUnprovenResult({ label: `Agent402 (${def.slug})`, refusal: body, settleResponse: failed ? settle : null });
    }

    /** Turn the route's answer to an x402-paid loopback into the MCP result:
     *  a <400 answer is the tool result plus the settle receipt in
     *  _meta["x402/payment-response"]; a settlement not decided yet is the
     *  pending result (no offer); a settle that failed after the handler is
     *  the route's explanation with no offer and none of the tool's output
     *  (failedSettleResult), whatever its receipt reads as; any other 402
     *  (a verify refusal: never settled, no settle receipt) is the
     *  invalid-payment result (a fresh PaymentRequired to sign again); a 5xx
     *  is the route's answer with no offer (the payment was presented); any
     *  other status is an error that was not charged. */
    async function translateX402Response(entry, target, params, isNamed, r, ip, signal) {
      const def = entry.def;
      if (r.status === 402) {
        let settle = null;
        try { settle = r.headers.get("payment-response") ? decodePaymentResponseHeader(String(r.headers.get("payment-response")).trim()) : null; } catch { settle = null; }
        const body = r.json && typeof r.json === "object" ? r.json : {};
        // Settlement not decided yet (a Gateway batched payment still
        // settling, a broadcast not yet confirmed, a verify that never got a
        // verdict): the route's own explanation and no offer, since signing a
        // fresh one could pay twice.
        if (isSettlementUndecided(body, settle)) {
          return buildSettlementPendingResult({ label: `Agent402 (${def.slug})`, refusal: body, retryAfterSeconds: r.headers.get("retry-after"), settleResponse: settle });
        }
        const failedSettle = failedSettleResult(def, r, body, settle);
        if (failedSettle) return failedSettle;
        const offer = paymentRequiredFromHeader(r.headers.get("payment-required")) || await x402Offer(target, params, ip, signal);
        const why = [offer?.error, body.error, body.hint].find((v) => typeof v === "string" && v.trim() && !/^payment required$/i.test(v.trim()));
        const out = offer && buildInvalidPaymentResult(offer, { reason: why || "Payment verification failed" });
        return out || { content: [{ type: "text", text: `Agent402 (${def.slug}): the payment was refused${why ? ` (${String(why).slice(0, 200)})` : ""} - not charged.` }], isError: true };
      }
      if (r.status >= 500) {
        // The route failed after the payment was presented: its own answer
        // and nothing to sign.
        const detail = r.json ? JSON.stringify(withoutPaymentRequired(r.json)) : String(r.text || "").slice(0, 500);
        return buildPaidRouteFailedResult({ label: `Agent402 (${def.slug})`, status: r.status, detail, refusal: r.json });
      }
      if (r.status >= 400) {
        const detail = r.json ? JSON.stringify(withoutPaymentRequired(r.json)) : String(r.text || "").slice(0, 500);
        return { content: [{ type: "text", text: `Agent402 (${def.slug}) HTTP ${r.status} - not charged: ${detail}` }], isError: true };
      }
      const receiptHeader = r.headers.get("payment-response");
      if (r.bytes) return withPaymentResponse(mcpBinaryResult({ slug: def.slug, bytes: r.bytes, contentType: r.contentType, headers: r.headers }), receiptHeader);
      const result = r.json !== undefined ? r.json : { text: r.text };
      if (isNamed) return withPaymentResponse(mcpJsonResult(result), receiptHeader);
      return withPaymentResponse({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { slug: def.slug, result },
      }, receiptHeader);
    }

    /** The USD a task's lost result is owed at: what the credential signed on
     *  its chain (the quote its 402 minted, premium and floor included), else
     *  the list price priced on the settle receipt's network. */
    function taskPaidUsd(def, credentialHeader, settle) {
      const signed = credentialSignedUsd(credentialHeader);
      if (signed) return signed.usd;
      return paidPriceUsd({ basePriceUsd: toolPriceUsd(def.slug), caip2: settle?.network ?? null });
    }

    /** The push exception a "not charged" line carries for this route: only
     *  where the 402 offers Tempo at all (src/mpp-tempo.js tempoOfferedFor:
     *  not an identity-bound route, not a long-running one), since no other
     *  route can be reached with a Tempo transfer sent before the call. */
    function pushClause(def) {
      return tempoOfferedFor({ identityBound: Boolean(def.identityBound) || isIdentityBoundRoute(def), longRunning: isLongRunningSlug(def.slug) }) ? PUSH_EXCEPTION : "";
    }

    /** The refusal a blocking paid call to a slow route gets ahead of the
     *  loopback (the HTTP route's respond_async_required, in this wire's terms). */
    function slowCallRefusalText(def) {
      const budget = Number(def.asyncProfile?.maxSeconds);
      const wait = Math.round(PAID_LOOPBACK_TIMEOUT_MS / 1000);
      return `respond_async_required: ${def.slug} can take up to ${budget} s, longer than this connector waits for a blocking call (${wait} s). Call it again declaring the MCP tasks extension on the request (_meta["${CLIENT_CAPABILITIES_META}"].extensions["${TASKS_EXTENSION}"]) and the run is handed back as a task handle to poll, or call the HTTP route ${def.route} with the header Prefer: respond-async, which answers 202 with a job link. This call was refused before any payment was taken${pushClause(def)}.`;
    }

    /** Turn a completed loopback response into the MCP answer. Shared by the
     *  blocking path and the task path, so a task result is byte-identical to
     *  what the blocking call would have returned (an ext-tasks MUST). Throws
     *  McpError(-32042) for a payment ask.
     *  Nothing on the paid path calls onServed: the loopback IS a request to
     *  the real route, which books its own sale, analytics row and failure
     *  count once; a second booking here counted every paid call twice. */
    function translateMppResponse(entry, meta, params, startedAt, isNamed, r, { softAsk = true, x402Required = null } = {}) {
      if (r.status === 402) {
        const challenges = challengesFromHeader(r.headers.get("www-authenticate"));
        // A credential whose settle failed (the route's PAYMENT-RESPONSE on
        // this 402): the route's explanation and nothing to pay again, as on
        // the x402 wire.
        if (credentialHeaderFromMeta(meta)) {
          let settle = null;
          try { settle = r.headers.get("payment-response") ? decodePaymentResponseHeader(String(r.headers.get("payment-response")).trim()) : null; } catch { settle = null; }
          const body = r.json && typeof r.json === "object" ? r.json : {};
          const failedSettle = failedSettleResult(entry.def, r, body, settle);
          if (failedSettle) return failedSettle;
        }
        if (!challenges.length) {
          // No MPP challenge on the 402 (gates not minting for this route):
          // the x402 offer alone when there is one, else the paid-access
          // instructions rather than an empty ask.
          const x402Only = x402Required ? buildPaymentRequiredResult(x402Required, { message: walletRequiredText(entry.def, { x402: true, mpp: false }) }) : null;
          return x402Only || { content: [{ type: "text", text: walletRequiredText(entry.def, { mpp: false }) }], isError: true };
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
          const mppMeta = { [MCP_PAYMENT_REQUIRED_META]: { httpStatus: 402, challenges, ...(problem ? { problem } : {}) } };
          // Both wires on one result: the x402 PaymentRequired as JSON in the
          // first text block (never structuredContent), the MPP challenges
          // unchanged in _meta, the readable text after.
          const both = x402Required ? buildPaymentRequiredResult(x402Required, { message: walletRequiredText(entry.def, { x402: true }), mppMeta }) : null;
          if (both) return both;
          return {
            content: [{ type: "text", text: walletRequiredText(entry.def) }],
            isError: true,
            _meta: mppMeta,
          };
        }
        // The message is what a host that does not speak MPP shows its user,
        // so a first ask carries every other way to pay, not only the MPP one.
        // Code and data are unchanged: an MPP client reads those, never the text.
        throw new McpError(presented ? MCP_PAYMENT_VERIFICATION_FAILED_CODE : MCP_PAYMENT_REQUIRED_CODE, problem?.detail || `Payment Required: ${walletRequiredText(entry.def)}`, { httpStatus: 402, challenges, ...(problem ? { problem } : {}) });
      }
      if (r.status >= 400) {
        const detail = r.json ? JSON.stringify(withoutPaymentRequired(r.json)) : String(r.text || "").slice(0, 500);
        return { content: [{ type: "text", text: `Agent402 (${entry.def.slug}) HTTP ${r.status}${r.status >= 400 && r.status < 500 ? ` - not charged${pushClause(entry.def)}` : `${Boolean(credentialHeaderFromMeta(meta)) && r.status === 502 ? " - settlement normally runs only after a successful handler; check the paying wallet before paying again" : " - not charged (settlement runs only after a successful handler)"}${pushClause(entry.def)}`}: ${detail}` }], isError: true };
      }
      const receipt = receiptFromHeader(r.headers.get("payment-receipt"));
      const receiptMeta = receipt ? { [MCP_RECEIPT_META]: { ...receipt, ...(challengeIdFromMeta(meta) ? { challengeId: challengeIdFromMeta(meta) } : {}) } } : {};
      if (r.bytes) {
        return { ...mcpBinaryResult({ slug: entry.def.slug, bytes: r.bytes, contentType: r.contentType, headers: r.headers }), ...(receipt ? { _meta: receiptMeta } : {}) };
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
          content: [{ type: "text", text: `Agent402 is at capacity for long-running ${entry.def.slug} runs right now - nothing was started and no payment was claimed. Retry shortly.` }],
          isError: true,
        };
      }
      // The run must OUTLIVE this HTTP response, so it gets its own abort
      // controller (the request's signal fires on res "close", which is exactly
      // what returning the handle causes) - and that controller is what
      // tasks/cancel aborts.
      const controller = new AbortController();
      // The handler's stages reach the task record through a progress sink
      // keyed on the loopback (src/job-progress.js). The task does not exist
      // until the gate window passes, so the newest stage waits until then.
      let progressTaskId = null, progressHeld = null;
      const slug = entry.def.slug;
      const withMessage = (patch) => ({
        ...patch,
        ...(patch.stage ? { statusMessage: `Running ${slug}: ${patch.stage}${patch.total ? ` (${patch.done} of ${patch.total} steps done)` : ""}.` } : {}),
      });
      const progressWriter = throttledProgressWriter((patch) => {
        if (!progressTaskId) { progressHeld = patch; return undefined; }
        return tasks.update?.(progressTaskId, withMessage(patch));
      });
      const progressSink = registerProgressSink(progressWriter);
      const endProgress = () => { progressWriter.cancel(); progressSink.release(); };
      const run = mppLoopback({
        def: entry.def, params, credentialHeader, ip,
        signal: controller.signal, idempotencyKey, heartbeatToken,
        timeoutMs: tasks.RUN_TIMEOUT_MS, progressKey: progressSink.key,
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
        endProgress();
        if (gate.e) throw gate.e;
        return translateMppResponse(entry, meta, params, startedAt, isNamed, gate.r, { softAsk: false });
      }

      // With the state database on, create() resolves once the row is stored
      // (file mode returns the record at once; await is a no-op there).
      const rec = await tasks.create({ slug: entry.def.slug, controller });
      if (rec) {
        progressTaskId = rec.taskId;
        if (progressHeld) { const held = progressHeld; progressHeld = null; try { await tasks.update?.(rec.taskId, withMessage(held)); } catch { /* advisory */ } }
      } else endProgress();
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

      settled.then(async ({ r, e }) => {
        endProgress();
        if (e) {
          const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
          let current = null;
          try { current = await tasks.get(rec.taskId); } catch { current = null; }
          if (aborted && current?.status === "cancelled") return; // cancel() already wrote the terminal state
          // No answer came back from the loopback, so no route booked this
          // run's outcome: the connector books it.
          onPaidCutoff(entry.def.slug, { statusCode: 504, errorMessage: aborted ? "task run aborted" : "task run failed", latencyMs: Date.now() - startedAt, heartbeatToken });
          // Never relay an upstream/internal error body to the buyer.
          await tasks.fail(rec.taskId, { code: TASK_INTERNAL_ERROR, message: aborted ? "The connector stopped waiting for the run." : "The run did not complete." },
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
          await tasks.fail(rec.taskId, { code, message: mcpErrorText(err) || "Payment required.", ...(err?.data ? { data: err.data } : {}) }, "Payment was required for this call; no payment was claimed.");
          return;
        }
        // Spec: `failed` is for JSON-RPC errors only. A tool result that
        // completed carrying isError:true is a COMPLETED task whose result says
        // it went wrong (and our text already says "not charged"), so a caller
        // can never mistake it for a silent empty success.
        // A result that cannot be retained books a debt: the x402 settle
        // receipt the 200 carries is the proof (success, chain, payer; the
        // MPP receipt names none of these), at what the credential signed on
        // that chain, never the list price. A Tempo-paid run carries no x402
        // receipt: its proof is built from the Tempo receipt (the transfer
        // hash, the chain) and the sender the credential's own signature
        // proves (src/mcp-mpp.js tempoSettleProof).
        const mppReceipt = receiptFromHeader(r.headers?.get?.("payment-receipt"));
        const settle = settleReceiptFromHeader(r.headers?.get?.("payment-response")) || tempoSettleProof(mppReceipt, credentialHeader);
        await tasks.complete(rec.taskId, out, { receipt: settle || mppReceipt, priceUsd: taskPaidUsd(entry.def, credentialHeader, settle) });
      }).catch(async (err) => {
        // `settled` never rejects, so this is a throw inside the completion
        // path itself (reading the answer, booking it, writing the record).
        // Left alone it would leave the task "working" until its TTL; it ends
        // failed, with the fault logged here and kept out of the buyer's text.
        endProgress();
        console.error(`[mcp-tasks] completion path threw for ${rec.taskId} (${entry.def.slug}): ${mcpErrorText(err, 200)}`);
        try {
          await tasks.fail(rec.taskId, { code: TASK_INTERNAL_ERROR, message: "The connector could not record the run's result." }, `The run's result could not be recorded by this connector. ${PAID_CUTOFF_TEXT}`);
        } catch { /* a terminal record is never rewritten */ }
      });

      return createTaskResult(rec);
    }

    server.setRequestHandler("tools/call", async (req) => {
      const { name: rawName, arguments: args = {} } = req.params;
      const name = resolveListedName(rawName);
      const overBound = toolInputBoundRefusal(rawName, args, maxToolInputElements);
      if (overBound) throw new McpError(ErrorCode.InvalidParams, overBound);
      // A request the transport counted on the payment bucket meets the
      // normal bucket too, unless this call reaches a paywall replay with its
      // payment: a credential on a discovery tool, an unknown tool or a free
      // tool's in-process run buys nothing over an unpaid call.
      if (paymentCall && !reachesPaidReplay(name, args, req.params?._meta)) {
        const budget = mcpReqLimiter.check(ip);
        if (budget.limited) return { content: [{ type: "text", text: reqLimitText(path, budget.retryAfterSeconds) }], isError: true };
      }
      if (scoped && HIDDEN_WHEN_SCOPED.has(name)) {
        return { content: [{ type: "text", text: `${rawName} is not available on ${path} - this endpoint serves one product (${[...flagshipSet].map(mcpNameOf).join(", ")}). The full catalog connector is ${baseUrl}/mcp.` }], isError: true };
      }
      try {
        if (name === "catalog.search") {
          // Funnel stage 1 (discovery) — same event the HTTP discovery
          // surfaces emit in server.js; env-gated no-op without PostHog.
          capturePostHogDiscovery({ surface: "mcp:catalog.search" });
          const q = String(args.query ?? "").trim();
          const { rows: results, topScore, matched } = searchTools(q, args.limit);
          // Multi-tool workflows that match the same query — surface them so an
          // agent asking "audit a domain" sees the whole security-audit pack
          // (callable in ONE payment via skill-<slug>, or step-by-step via
          // prompts/get) alongside the tools.
          const workflows = rankSkillPacks(q, { k: 2, baseUrl, toolPriceUsd, toolFree: (slug) => freeSlugs.has(slug) });
          // Weak/empty match: nudge toward request_tool instead of a dead
          // end. No wish recorded here — search_tools is a looser lexical
          // search than find_tool, not a task-intent signal; the explicit
          // request_tool call (or find_tool's find-miss capture) is the
          // actual demand signal.
          const weak = results.length === 0 || topScore < FIND_WEAK_SCORE;
          if (!results.length && !workflows.length) {
            return mcpJsonResult({
              results: [],
              // A caller that passed no query is told which argument to pass,
              // not shown an empty string in quotes.
              message: q
                ? `No tools matched "${q}". Full catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`
                : `catalog.search needs a "query" argument: what the tool should do (for example "convert miles to kilometers"). Full catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
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
            ...(t.reversed ? { reversed: true } : {}),
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
              upgrade: d ? decideUpgradeOffer({ next: "decide.execute" }) : null,
              executable: Boolean(catalog["POST /api/decide/execute"]),
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
            // The stated conversion direction and whether any tool serves it (src/find.js).
            ...(r.direction ? { direction: r.direction } : {}),
            ...(weak && !relatedSellers && !plan ? { hint: WISH_HINT_TEXT } : {}),
            usage: `Run catalog.call with the chosen {slug, params}. Free results execute here; paid tools are ${inCallWires ? `payable here, in the call, over ${inCallWires}, or` : "paid"} via the agent402-mcp npm server (a wallet, or a prepaid credits key already issued).`,
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
            return { content: [{ type: "text", text: mcpErrorText(err) }], isError: true };
          }
        }
        if (name === "server.describe") {
          capturePostHogDiscovery({ surface: "mcp:about" });
          const install = mcpInstallHints(baseUrl);
          const frontDoor = frontDoorJson(catalog, baseUrl);
          return mcpJsonResult({
            // The front door leads (src/front-door.js): the same block
            // /llms.txt and /agents.md open with (the unpaid 402 body carries
            // its access line and guide link only with FRONT_DOOR_402=on).
            // startHere.firstJob (kept for clients that read it) opens with
            // the same first-call sentence, so the answer has one first call.
            frontDoor,
            service: baseUrl,
            connector: "hosted free tier (authless)",
            maintainer: "Havok Holdings LLC",
            positioning: `${leadSentence({ mpp: mppMethodsSummary().enabled })} It is the applied layer of Agentic Finance: software agents that pay and get paid on their own, per request, ${mppMethodsSummary().enabled ? "over the two open wires - x402 and MPP (Machine Payments Protocol) - both answered on the same 402" : "over x402"}. Definition + glossary: ${baseUrl}/agentic-finance, ${baseUrl}/glossary.`,
            // Flagship-first positioning: search/answer as the default job,
            // evergreen 500+ catalog, models and reports named beside the tools.
            startHere: {
              firstJob: `${frontDoor.firstCall}${catalog["POST /api/decide"] ? " A job with more than one step: call decide.plan, then decide.execute (the plan fee is credited toward the run)." : ""} Otherwise catalog.find with your task. Agent402 sells three things on one key: deterministic utilities (no model in that serving path), a metered model gateway on four wires (OpenAI chat, OpenAI Responses, Anthropic Messages, Gemini; /v1/metered), and finished report products. Flagship tools first, 500+ long-tail tools via catalog.find / catalog.search / catalog.call.`,
              flagships: [...flagshipSet].map((slug) => ({
                mcpName: mcpNameOf(slug),
                slug,
                price: tools.get(slug).def.price,
                access: tools.get(slug).free ? "free here" : inCallWires ? `paid: payable here over ${inCallWires}, or with a wallet on the npm server` : "wallet required on this hosted connector",
              })),
              llmGateway: `Call a model at ${baseUrl}/v1/metered/chat/completions, the default (also /v1/metered/messages and /v1/metered/responses; model-backed, from ${meteredFromPrice()} a call). ${meteredQuoteSentence().replace(/`/g, "")} No API key: a funded wallet IS the account. ${flatTiersLine().replace(/`/g, "")} Reach the gateway via catalog.call (slugs v1-chat-metered, v1-chat-nano, v1-chat-auto, v1-embeddings) on the npm server.`,
              freeTier: `${freeCount} pure-CPU tools run free right here with no wallet - payable with ~milliseconds of proof-of-work CPU (discover via catalog.find / catalog.search).`,
            },
            install,
            tools: tools.size,
            toolsEvergreen: "500+",
            freeHere: freeCount,
            walletOnly: tools.size - freeCount,
            rateLimit: RATE_LIMIT_COPY,
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
            paidAccess: `Every tool, no rate limit: pay per call in ${RAILS_PAREN} via the x402 protocol - npx agent402-mcp with AGENT_KEY (EVM) and/or SOLANA_AGENT_KEY (Solana), or a prepaid credits key already issued (AGENT402_CREDITS_KEY), or any x402 HTTP client - or over MPP (Machine Payments Protocol) with an mppx client, settling USDC on Base/Celo or USDC.e (and PathUSD) natively on Tempo. No signup, no API key; most tools ${TYPICAL_PRICE_RANGE.text} per call${gatewayRange ? `, LLM gateway tiers ${gatewayRange}` : ""}, multi-tool skill packs ${PACK_PRICE_RANGE.text}.`,
            ...(sellersListed ? { ecosystem: "Call sellers.list to see which x402 sellers (any wallet, not just this host) are settling the most USDC (primarily on Base) in the last 24h, or sellers.list with wire=mpp for MPP sellers ranked by on-chain USDC.e transfers on Tempo - discovers the live economy beyond this catalog." } : {}),
            missingATool: "Call demand.request (or POST /api/wish) with what you needed. We cluster and track demand - repeated requests get built.",
            docs: `${baseUrl}/llms.txt`,
          });
        }
        if (name === "decide.feedback" && decideFeedback) {
          try { return mcpJsonResult(decideFeedback(args, { ip })); }
          catch (err) { return { content: [{ type: "text", text: err.statusCode && err.statusCode < 500 ? mcpErrorText(err) : "feedback failed" }], isError: true }; }
        }
        if (name === "sellers.list" && sellersListed && args.wire === "mpp") {
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
          // Seller-written names are cleaned and capped at serve time, and a
          // name that trips the listing screen is replaced and marked.
          const rows = board.map((r, i) => {
            const named = r.self ? null : (r.sellers || []).map((s) => screenSellerNameOn(s, s?.name, String(s?.url || "").replace(/^https?:\/\//, "") || null));
            return {
            rank: i + 1,
            name: r.self ? "this host" : named.map((n) => n.name).filter(Boolean).join(", ") || "unnamed recipient",
            ...(named ? (named.find((n) => n.marker.untrustedContent)?.marker || {}) : {}),
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
            };
          });
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
        if (name === "sellers.list" && sellersListed) {
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
            // Seller-written name: cleaned and capped at serve time, replaced
            // and marked when it trips the listing screen.
            const named = isSelf ? { name: r.name, marker: {} } : screenSellerNameOn(r, r.name, String(r.homepage || "").replace(/^https?:\/\//, "") || null);
            return {
              rank: r.rank,
              name: named.name,
              ...named.marker,
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
            credits: { onSale: creditsSalesEnabled(), how: `${creditsSalesEnabled() ? `packs are sold by card at ${baseUrl}/credits` : "new credits are not on sale; a key already issued keeps working"}: Authorization: Bearer a402_<key> on any paid HTTP route except the wallet-identity-bound ones and the routes that buy from an outside seller (the router's execute tiers, seller-payability, decide-execute and the flight routes), which take a wallet payment, or AGENT402_CREDITS_KEY on the agent402-mcp npm server; the list price is held before the call and debited only on success`, balance: `${baseUrl}/api/credits/balance` },
            // DERIVED, never typed. This block quoted the pre-2026-08-23 ladder
            // for three weeks - every figure understated 1.7x to 3.4x - and an
            // agent budgeting from a machine surface under-budgets, pays, and
            // is refused. llms.txt was right the whole time because it derives
            // its numbers; this does the same now.
            reports: { what: `finished, cited report products with a data appendix - ${reportLadder().agentLadder} - the same endpoints over x402/MPP or by card`, human: `${baseUrl}/reports`, humanPricing: `people pay ${reportLadder().cardLadder} by card; the card price includes payment processing, so an agent paying per call pays the lower tool price above for the same report`, monitors: `${baseUrl}/monitors`, monitorPricing: reportLadder().monthlySentence },
            freeTier: {
              pureCpuToolsFree: freeCount,
              how: [
                "pure-CPU tools run free here (rate-limited)",
                ...(payX402 ? ["wallet-only tools are payable in the call on this connector over x402 (the first ask is an isError tool result whose first text block is the x402 PaymentRequired as JSON; send the signed payment in _meta[\"x402/payment\"] and the settle receipt returns in _meta[\"x402/payment-response\"] - an x402 MCP client handles it; a free tool at its rate limit offers the same, so a paying client is served past it)"] : []),
                ...(payMpp ? [`${payX402 ? "and" : "wallet-only tools are payable on this connector"} over MPP (the first ask is a tool result whose challenges ride in _meta[\"org.paymentauth/payment-required\"]; on the tasks path the ask is JSON-RPC error -32042, and a presented credential that is refused is -32043; send the credential in _meta[\"org.paymentauth/credential\"], receipt returns in _meta[\"org.paymentauth/receipt\"] - mppx's McpClient.wrap() handles it)`] : []),
                ...(longCallNote ? [longCallNote] : []),
                payX402 || payMpp ? "or via the npm server with a wallet" : "wallet-only tools are not payable on this connector, so run the npm server with a wallet or call them over HTTP with an x402 client",
              ].join("; "),
              proofOfWork: "a walletless client can solve a proof-of-work puzzle instead of paying on eligible tools",
            },
            pay: {
              model: "HTTP 402 + x402, settled in USDC on-chain, non-custodial (you hold the key)",
              mpp: `every paid endpoint also accepts MPP (Machine Payments Protocol, the Payment HTTP auth scheme): the same 402 carries a WWW-Authenticate: Payment challenge, an mppx client pays out of the box, settling USDC on Base/Celo or USDC.e (and PathUSD) natively on Tempo - see ${baseUrl}/what-is-mpp`,
              rails: RAILS_PAREN,
              setup: `run the agent402-mcp npm server: \`npx agent402-mcp\` with ${npmEvmSetup} and/or SOLANA_AGENT_KEY=<base58 secret> for Solana. No signup, no API key.`,
              // DERIVED. Both ranges here were hand-typed and kept through two
              // repricings: the pack ceiling was over ten times the real one and
              // the report range stopped a tier short of the priciest product.
              // An agent budgets from this surface, so an under-quote is a 402 it
              // was told not to expect - the same defect this tool's `reports`
              // line was fixed for, one field away. test-price-prose pins the
              // retired figures by name, so do not quote them back in here.
              prices: `most tools ${TYPICAL_PRICE_RANGE.text} per call${gatewayRange ? `, LLM gateway tiers ${gatewayRange}` : ""} (the metered tier is quoted per request${networkFloorUsd(ROBINHOOD_CAIP2) > 0 ? `; on Robinhood Chain (USDG) every call costs at least $${networkFloorUsd(ROBINHOOD_CAIP2)}` : ""}${premiumClause() ? `; ${premiumClause()}, listed under payment.premiumUsdByNetwork on ${baseUrl}/api/pricing` : ""}), multi-tool skill packs ${PACK_PRICE_RANGE.text}, model-backed report products ${agentReportPriceRange()?.text || "priced per product"} - see each tool's exact price in catalog.search results`,
              llmGateway: `the /v1 OpenAI-compatible endpoints settle the same way. Default: point any OpenAI SDK at ${baseUrl}/v1/metered through an x402-paying fetch, calling POST /v1/metered/chat/completions or the /v1/metered/messages and /v1/metered/responses wires. ${meteredQuoteSentence().replace(/`/g, "")} The flat tiers${gatewayFlat ? ` (${gatewayFlat})` : ""} stay as the predictable-price option at ${baseUrl}/v1. No API key, the wallet is the account`,
              retries: "an Idempotency-Key header (or the x402 payment-identifier extension) replays a served paid call instead of charging again; a request re-sent with the same signed EVM payment and no key is answered from its first answer too (X-Replayed-Answer: 1), except on identity-bound routes, routes with a lasting effect and streamed calls",
              // The Circle Gateway batched option, read from the live offer
              // (src/gateway-nanopayments.js); absent while it is off.
              ...(gatewayOfferPublic() ? { batched: `on ${gatewayOfferNetworkNames().join(" and ")} the 402 also carries a Circle Gateway batched accept (extra.name ${gatewayOfferPublic().kind}) at the same price: after a USDC deposit into Circle Gateway, each payment is a signature against that balance with no gas per call, settled off chain in batches. agent402-mcp and agent402-client pay the plain accept; a client that signs under the Gateway domain can choose the batched one` } : {}),
            },
            ...(mppStartHere.length ? { mppStartHere: { what: `fast, low-priced routes that ${mppFlagshipOffersPhrase()}: a good first call for a new MPP client (call by slug with catalog.call, or pay the HTTP route with mppx)`, routes: mppStartHere, more: `${baseUrl}/what-is-mpp#start-here` } } : {}),
            spendControls: { perCall: "AGENT402_MAX_PER_CALL caps any single call (on by default; off disables)", totalBudget: "AGENT402_BUDGET caps cumulative spend for the session (opt-in; unset means no session cap)", enforced: "on the payment that is signed" },
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
        const { isNamed, resolvedSlug, entry } = callTargetOf(name, args);
        // After resolveListedName, catalog.call is the envelope path; everything
        // else must be a named flagship (or legacy alias mapped above).
        if (name !== "catalog.call" && !isNamed) {
          return { content: [{ type: "text", text: `Unknown tool ${quotedEcho(rawName)}.` }], isError: true };
        }
        if (!entry) {
          // A slug we RETIRED is named as retired, with its replacement, and
          // counted like the HTTP 410 (tool_gone, surface mcp), so an old
          // catalog copy walked over the connector is visible too.
          const gone = retiredEntryForSlug(resolvedSlug);
          if (gone) {
            const rep = gone.replacement ? tools.get(gone.replacement) : null;
            try { capturePostHogToolGone({ route: gone.route, replacement: rep ? rep.def.route : "GET /api/find", source: toolGoneSourceOf({ headers: reqHeaders, surface: "mcp" }) }); } catch { /* telemetry never breaks a response */ }
            const what = gone.kind === "pack" ? "Skill pack" : "Tool";
            return { content: [{ type: "text", text: `${what} ${gone.slug} was retired on ${gone.retiredAt}. ${rep ? `Use slug ${rep.def.slug} instead (${rep.def.route}).` : "There is no direct replacement; use catalog.search to find the closest live tool."}${!rep && gone.note ? ` ${gone.note}` : ""}` }], isError: true };
          }
          return { content: [{ type: "text", text: `Unknown slug ${quotedEcho(resolvedSlug)}. Use catalog.search to find the right slug.` }], isError: true };
        }
        // The x402 MCP wire: a call carrying _meta["x402/payment"] (and no MPP
        // credential: when both ride along, MPP is used, as before this wire)
        // is paid over x402 on any tool, a free one included, and never meets
        // the free-tier limiter: a buyer who pays is never refused for rate.
        const x402Read = x402Loopback && !credentialHeaderFromMeta(req.params?._meta) ? readPaymentFromMeta(req.params?._meta) : null;
        if (x402Read && (!x402Read.ok || x402Read.payment)) {
          return await payOverX402(entry, req.params, args, isNamed, ip, signal, x402Read);
        }
        if (!entry.free) {
          // Native MPP (2026-08-19): with the MPP gates mounted, a paid tool is
          // payable right here on the connector. The call is replayed as a
          // loopback HTTP request to our own paid route so the REAL gates
          // verify + settle (settlement authority unchanged); we only
          // translate wire shapes (see src/mcp-mpp.js). Without the gates
          // (no MPP_SECRET_KEY) the old paid-access instructions stand.
          if (!mppLoopback) {
            // No MPP gates: the x402 offer alone, when this boot has a paywall.
            // A long call gets the text alone (its HTTP route, as a job).
            const offer = isLongCall(entry.def) ? null : await x402Offer(x402TargetOf(entry.def, isNamed), paidParamsOf(args, isNamed), ip, signal);
            return (offer && buildPaymentRequiredResult(offer, { message: walletRequiredText(entry.def, { x402: true }) }))
              || { content: [{ type: "text", text: walletRequiredText(entry.def) }], isError: true };
          }
          return await payOverMpp(entry, req.params, args, isNamed, ip, signal);
        }
        const toolBudget = mcpLimiter.check(ip);
        if (toolBudget.limited) {
          const limitText = `Free-tier rate limit reached (${RATE_LIMIT_COPY}); room again in about ${toolBudget.retryAfterSeconds} s.`;
          // A free tool at its limit offers its own x402 challenge (the HTTP
          // route's), so a client that can pay is served now: it pays in
          // _meta["x402/payment"] and the call skips this limiter.
          const offer = isLongCall(entry.def) ? null : await x402Offer(entry.def, paidParamsOf(args, isNamed), ip, signal, { reuse: true });
          return (offer && buildPaymentRequiredResult(offer, { message: `${limitText} To be served now, pay this call over x402: sign one of the accepts in this result's PaymentRequired and call again with the payment in _meta["x402/payment"] (an x402 MCP client does this automatically). Or pay per call from the npm server: npx agent402-mcp with AGENT_KEY. ${baseUrl}/llms.txt` }))
            || { content: [{ type: "text", text: `${limitText} For unmetered access pay per call via x402: npx agent402-mcp with AGENT_KEY. ${baseUrl}/llms.txt` }], isError: true };
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
          const tooDeep = inputDepthRefusal(params);
          if (tooDeep) throw Object.assign(new Error(tooDeep), { statusCode: 400 });
          const callReq = { headers: {}, query: params, body: params, ip, signal };
          result = await runAsCallerOf(callReq, () => entry.def.handler(params, callReq));
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
          // Whose fault is read from the error's own attribution and kind
          // (src/upstream-deadline.js, src/tool-error-fields.js): a third
          // party is named only when a definite answer from it set
          // "upstream"; our own 500 says it is ours, our own limit names the
          // limit, and a URL the caller supplied gets "check the URL, or retry".
          const upstreamStatus = Number.isInteger(handlerErr?.upstreamStatus) ? handlerErr.upstreamStatus : null;
          const attribution = attributionOf(handlerErr);
          const status = handlerErr.statusCode || 500;
          const hint = {
            error: mcpErrorText(handlerErr),
            tool: entry.def.slug,
            ...(upstreamStatus ? { upstreamStatus } : {}),
            ...(attribution ? { attribution } : {}),
            ...(typeof handlerErr?.hint === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(handlerErr.hint) ? { hint: handlerErr.hint } : {}),
            ...(Number.isInteger(handlerErr?.retryAfter) ? { retryAfterSeconds: handlerErr.retryAfter } : {}),
            ...(notCallersInput(handlerErr, status)
              // The free tier: no credential rides along here, so there is
              // nothing a push exception could apply to.
              ? faultAdvice(handlerErr, status)
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
          return mcpBinaryResult({ slug: entry.def.slug, bytes: result.__binary, contentType: result.contentType, headers: result.headers });
        }
        // Named flagships: structuredContent is the native tool result (matches
        // FLAGSHIP_OUTPUT_SCHEMAS). call_tool: envelope {slug, result} so the
        // meta outputSchema has stable named fields while content text stays
        // the raw tool JSON agents already parse.
        // A free answer past the connector's ceiling is cut and says so in
        // fields (src/mcp-answer-bound.js).
        // The text block is built once: when it fits the ceiling the compact
        // form fits too (it is the same JSON less whitespace), so it is sent
        // as built and the answer is not serialized again to be measured.
        // When it does not fit, the compact form is sent instead.
        const maxBytes = mcpMaxAnswerBytes();
        let pretty;
        try { pretty = JSON.stringify(result, null, 2); } catch { pretty = undefined; }
        if (typeof pretty === "string" && (pretty.length * 3 <= maxBytes || Buffer.byteLength(pretty) <= maxBytes)) {
          if (isNamed) return mcpJsonResult(result, pretty);
          return { content: [{ type: "text", text: pretty }], structuredContent: { slug: entry.def.slug, result } };
        }
        const { value, bound } = boundAnswer(result, maxBytes);
        if (bound) result = withAnswerBound(value, bound);
        // Past this point the indented form is over the ceiling, so the text
        // block is compact whether or not the answer was cut: a cut answer as
        // it was sized, an uncut one as the form the bound measured to fit.
        const compact = JSON.stringify(result);
        if (isNamed) return mcpJsonResult(result, compact);
        return {
          content: [{ type: "text", text: compact }],
          structuredContent: { slug: entry.def.slug, result, ...(bound ? { answerBound: bound } : {}) },
        };
      } catch (err) {
        // A payment ask is a JSON-RPC ERROR (-32042) by mppx's wire, not an
        // isError text the client would show verbatim - let the SDK send it.
        if (err instanceof McpError) throw err;
        return { content: [{ type: "text", text: `Agent402: ${mcpErrorText(err)}` }], isError: true };
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
  // tasks/get carries the job's progress (src/job-progress.js) in
  // _meta["org.agent402/progress"]: status queued|running|succeeded|failed,
  // stage, progress 0-1, etaSeconds; a live task's poll interval follows it.
  let profileBySlug = null;
  function withTaskProgress(out, rec) {
    try {
      profileBySlug ??= new Map(Object.values(catalog).filter((d) => d?.asyncProfile).map((d) => [d.slug, d.asyncProfile]));
      const profile = profileBySlug.get(rec.slug) || null;
      const pollSeconds = Math.max(1, Math.round((rec.pollIntervalMs || 5000) / 1000));
      const { retryAfterSeconds, ...view } = progressView(rec, { pollSeconds, basisSeconds: profile?.basisSeconds ?? null, expectedSeconds: profile?.expectedSeconds ?? null, maxSeconds: profile?.maxSeconds ?? null });
      if (rec.status === "working" && retryAfterSeconds) out.pollIntervalMs = retryAfterSeconds * 1000;
      out._meta = { ...(out._meta || {}), [TASK_PROGRESS_META]: view };
    } catch { /* progress is advisory */ }
    return out;
  }

  async function handleTaskRpc(body) {
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
    try { rec = await tasks.get(taskId); } catch { return err(TASK_INTERNAL_ERROR, "Internal error reading task state"); }
    if (rec === "expired") return err(TASK_INVALID_PARAMS, "Failed to retrieve task: Task has expired");
    if (!rec) return err(TASK_INVALID_PARAMS, "Failed to retrieve task: Task not found");

    if (body.method === "tasks/get") return okResult(withTaskProgress(detailedTask(rec), rec));
    if (body.method === "tasks/cancel") {
      // Cooperative and eventually consistent: we abort the live run, which
      // makes the paid request a non-200 and CANCELS settlement.
      try { await tasks.cancel(taskId); } catch { return err(TASK_INTERNAL_ERROR, "Internal error canceling task"); }
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // 2026-07-28 serving (SDK v2 createMcpHandler, modern-only: 2025-era traffic
  // never reaches it, see app.post below). One handler per mount, built on the
  // first modern request; the factory builds a fresh server per request from
  // the context app.post sets, so the two eras share buildServer and cannot
  // drift apart.
  const mcpRequestContext = new AsyncLocalStorage();
  let _modernHandler = null;
  const modernHandler = () => (_modernHandler ||= createMcpHandler(() => {
    const c = mcpRequestContext.getStore();
    return buildServer(c.ip, c.signal, c.heartbeatToken, c.serverOpts);
  }, { legacy: "reject", onerror: (err) => console.warn(`[mcp] 2026-07-28 request refused or failed: ${logSafe(mcpErrorText(err, 160), 160)}`) }));

  // Stateless mode: a fresh server+transport per POST, no session table. Every
  // JSON-RPC message (including initialize) is self-contained, which survives
  // redeploys and needs no sticky routing.
  app.post(path, async (req, res) => {
    // req.ip is derived via the app's "trust proxy" setting (TRUST_PROXY_HOPS:
    // the edge-appended XFF hop behind a proxy, the socket address with none
    // trusted), NOT a spoofable client-supplied X-Forwarded-For value. This is the only abuse control on the free tier,
    // so it must not be bypassable by injecting a header.
    const ip = (req.ip || req.socket.remoteAddress || "?").trim();
    // R-11 outer gate #1: per-IP raw-request cap, BEFORE allocating anything.
    // A tools/call carrying a plausible payment (carriesPayment) is counted on
    // the larger payment bucket here instead; its handler then holds it to
    // this bucket too unless the call reaches a paywall replay, so a junk or
    // misplaced credential buys nothing over an unpaid call.
    const paymentCall = carriesPayment(req.body);
    const reqBudget = (paymentCall ? mcpPaidReqLimiter : mcpReqLimiter).check(ip);
    if (reqBudget.limited) {
      // A client that is told when to come back waits; one that is not retries at once.
      res.setHeader("Retry-After", String(reqBudget.retryAfterSeconds));
      return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: `Too many requests to ${path} - slow down and retry shortly.` }, id: req.body?.id ?? null });
    }
    // MCP Tasks (io.modelcontextprotocol/tasks). Answered here, ahead of the SDK
    // transport, for two reasons: polling must not consume a transport slot (it
    // is cheap and frequent), and the installed SDK implements the older
    // 2025-11-25 CORE tasks wire (tasks/result + tasks/list, nested `task`,
    // ttl/pollInterval), which is not the shape this extension puts on the wire.
    // It stays behind the per-IP request limiter above - the spec asks for rate
    // limiting on task operations to bound polling and id enumeration.
    // The protocol era of this request (see the imports): the SDK's own
    // classification, from the parsed body and the standard headers.
    // A request it cannot classify is served as 2025-era traffic.
    const modern = !(await isLegacyRequest(eraProbeOf(req), req.body ?? undefined).catch(() => true));
    if (tasks && isTaskMethod(req.body?.method)) {
      const handled = await handleTaskRpc(req.body);
      // 2026-07-28 HTTP: a missing required client capability is a 400; every
      // other task answer, and every answer to a 2025-era request, is a 200.
      return res.status(modern && handled.error?.code === TASK_MISSING_CAPABILITY ? 400 : 200).json(handled);
    }
    // Skills (io.modelcontextprotocol/skills): skills/list and skills/get are
    // static answers over the skill set built at mount, answered here because
    // the installed SDK has no such methods. Behind the per-IP limiter above.
    // With skills off they fall through to the SDK's method-not-found.
    if (skillSet && isSkillMethod(req.body?.method)) {
      const answer = handleSkillsRpc(req.body, skillSet);
      // A notification gets no JSON-RPC reply: an empty 202, as the SDK transport answers one.
      return answer ? res.status(200).json(answer) : res.status(202).end();
    }
    const isInitialize = req.body?.method === "initialize";
    const isDiscover = req.body?.method === "server/discover";
    // The answers that show capabilities: initialize (2025 era) and
    // server/discover (2026-07-28). Skills appear there only for a client that
    // declared the extension on that request.
    const skillsCaps = Boolean(skillSet) && (!(isInitialize || isDiscover) || clientDeclaresSkills(req.body?.params));
    // R-11 outer gate #2: global in-flight transport ceiling, BEFORE building
    // the server/transport (bounds allocation under an initialize/malformed flood).
    if (mcpInFlight >= MCP_MAX_CONCURRENT) {
      return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint is at capacity - retry shortly." }, id: req.body?.id ?? null });
    }
    // Adoption telemetry: every MCP session announces its client at
    // initialize (e.g. "claude-ai", "claude-code"), or in the envelope of a
    // 2026-07-28 server/discover. In-memory since boot.
    const ci = isInitialize ? req.body?.params?.clientInfo : isDiscover ? req.body?.params?._meta?.[CLIENT_INFO_META_KEY] : null;
    if (ci?.name && mcpClients.size < 500) {
      // clientInfo is attacker-controlled — sanitize before it lands in the log
      // line OR the in-memory telemetry map (audit F24).
      const key = logSafe(`${ci.name}@${ci.version || "?"}`, 80);
      mcpClients.set(key, (mcpClients.get(key) || 0) + 1);
      console.log(`[mcp] ${isInitialize ? "initialize" : "discover"} from ${key}`);
    }
    mcpInFlight++;
    let deadlineTimer = null;
    const ac = new AbortController();
    let transport = null;
    let run = null;
    try {
      const heartbeatToken = typeof req.headers["x-heartbeat-token"] === "string" ? req.headers["x-heartbeat-token"] : null;
      const rawMeta = req.body?.params?._meta;
      const declaredCapabilities = rawMeta && typeof rawMeta === "object" ? rawMeta[CLIENT_CAPABILITIES_META] : undefined;
      const serverOpts = { skillsCaps, reqHeaders: req.headers, paymentCall, declaredCapabilities };
      // Client disconnect: abort in-flight handler work AND close the transport
      // (F14) — not just close the transport while the handler keeps running.
      res.on("close", () => { ac.abort(); try { transport?.close(); } catch { /* already closing */ } });
      if (modern) {
        // 2026-07-28: the SDK's handler validates the envelope and the
        // standard headers, answers server/discover, and builds this
        // request's server from the factory, which reads this context.
        const webReq = await toWebRequest(req, req.body, { signal: ac.signal });
        run = mcpRequestContext.run({ ip, signal: ac.signal, heartbeatToken, serverOpts }, () => modernHandler().fetch(webReq, { parsedBody: req.body }))
          .then((response) => writeWebResponse(res, response, ac.signal));
      } else {
        transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await buildServer(ip, ac.signal, heartbeatToken, serverOpts).connect(transport);
        run = transport.handleRequest(req, res, req.body);
      }
      // R-11/F14: per-request deadline. On fire, abort the handler and close the
      // transport so it settles, then (in finally) await that settle before the
      // slot is released — mcpInFlight never undercounts truly-live work.
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          ac.abort();
          try { transport?.close(); } catch { /* already closing */ }
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
            : `${label}: the connector hit an internal error handling this call (${mcpErrorText(err, 120)}). ${paid ? PAID_CUTOFF_TEXT : `${UNPAID_CUTOFF_TEXT} Retry shortly.`}`;
          // A 2026-07-28 result names its kind (resultType); a 2025 one never did.
          res.status(200).json({ jsonrpc: "2.0", id: req.body.id, result: { ...(modern ? { resultType: "complete" } : {}), content: [{ type: "text", text }], isError: true } });
        } else {
          res.status(err.__deadline ? 504 : 500).json({ jsonrpc: "2.0", error: { code: -32603, message: mcpErrorText(err) }, id: req.body?.id ?? null });
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
