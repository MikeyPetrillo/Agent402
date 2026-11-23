#!/usr/bin/env node
// Agent402 MCP server, exposes the agent402.tools catalog (500+ pay-per-call
// web tools) to any MCP client (Claude, ChatGPT, custom agents) and settles
// payment underneath, so the model never sees the 402 dance:
//
//   • AGENT_KEY=0x…          pay in USDC via x402 on the EVM chains (Base/Polygon/Arbitrum)
//   • SOLANA_AGENT_KEY=base58 pay in USDC via x402 on Solana
//   • no key                  pay with compute (proof-of-work) on the eligible tools
//
// The full catalog is too large to register as individual MCP tools, so the
// high-value tools are first-class and everything else is reachable through
// search_tools + call_tool.
//
// Config (env):
//   AGENT402_URL          target service (default https://agent402.tools)
//   AGENT_KEY             hex private key of a funded EVM wallet (USDC on Base/Polygon/Arbitrum), optional;
//                         with or without 0x. Unset, the key `npx agent402-mcp setup` stored is read
//                         from the OS keychain (./key-store.js; AGENT402_KEY_STORE=off skips it)
//   SOLANA_AGENT_KEY      base58 (or JSON byte-array) secret key of a funded Solana wallet (USDC on Solana), optional
//   AGENT402_TOOLS        comma-separated slugs to expose first-class (overrides default)
//   AGENT402_MAX_PER_CALL refuse any single call priced above this many USD (default 5; 0 or off disables)
//   AGENT402_CREDITS_KEY  a prepaid credits key (a402_...); pays per successful call with no wallet,
//                         on Agent402's own services only (outside-seller routes need a wallet)
//   AGENT402_BUDGET       optional hard cap on total USD spent this session (no cap by default)
//   AGENT402_MAX_USD_PER_DAY / AGENT402_MAX_USD_PER_MONTH
//                         optional caps per UTC day / month that hold across restarts (./spend-ledger.js)
//   AGENT402_OUTPUT_DIR   where media answers are written (./media-output.js); AGENT402_MEDIA_INLINE=1
//                         returns them inline instead; an image up to AGENT402_MEDIA_INLINE_MAX_BYTES
//                         (default 1 MB) is also inline beside its file
//   AGENT402_SHOW_ROUTER  "1" lists router.execute and sellers.list without a wallet (both are listed
//                         when a wallet or credits key is set)
//   AGENT402_NETWORKS     restrict + order the chains to pay on (e.g. "robinhood" for USDG on
//                         Robinhood Chain, "base,solana", or a raw CAIP-2 like eip155:4663), optional
import { readFileSync } from "node:fs";
import { format } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { quoteOf, guardSigning, signedExpirySeconds, MAX_VALIDITY_SECONDS } from "./known-assets.js";
import { parseNetworkPrefs, withNetworkPreference, distrustFetch } from "./networks.js";
import { fetchDiscovery, discoveryFailure, getDiscoveryJson } from "./discovery.js";
import { awaitJob, shouldRequestAsync, AsyncJobPendingError, DEFAULT_ASYNC_TIMEOUT_MS, jobState } from "./async-job.js";
import { solvePowAsync } from "./pow-solver.js";
import { normalizeEvmKey, evmKeyOrNull, walletKeyError } from "./wallet-key.js";
import { configDir } from "./config-dir.js";
import { ledgerFromEnv } from "./spend-ledger.js";
import { keyStoreKind, readStoredKey } from "./key-store.js";
import { mediaInline, inlineImageMaxBytes, outputDirCandidates, writableOutputDir, saveMedia, extractMediaFields, isBinaryBody, bareType, sniffType, savedLine } from "./media-output.js";
// MCP SDK v2 (@modelcontextprotocol/server, pinned exactly in package.json).
// Handlers are registered by method name. The server answers the 2024-11-05
// through 2025-11-25 revisions it did under SDK v1, and the SDK lifts every
// io.modelcontextprotocol/* key out of params._meta before a handler runs, so
// a handler that needs one reads it from the raw message (this server reads
// none: progressToken is not such a key).
import { Server, ProtocolError, ProtocolErrorCode as ErrorCode } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  FLAGSHIP_MCP_NAMES,
  META_MCP_NAMES,
  resolveListedName,
  FLAGSHIP_OUTPUT_SCHEMAS,
  META_OUTPUT_SCHEMAS,
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_WEBSITE,
  mcpJsonResult,
  outputSchemaFromExample,
  mcpInitializeInstructions,
  hostedConnectorWiresFor,
  toolInputBoundRefusal,
  AGENT402_MCP_VERSION,
  clipToolDescription,
} from "./output-schemas.js";

// A protocol error whose message starts "MCP error <code>: ", as SDK v1's
// McpError wrote it, so every error answer reads as it did before the move.
class McpError extends ProtocolError {
  constructor(code, message, data) { super(code, `MCP error ${code}: ${message}`, data); }
}

// `npx agent402-mcp setup` stores the wallet key and prints the client config
// (./setup.js); the server below never starts.
if (process.argv[2] === "setup") {
  const { runSetup } = await import("./setup.js");
  process.exit(await runSetup());
}

const DEFAULT_URL = "https://agent402.tools";
const BASE = (process.env.AGENT402_URL || DEFAULT_URL).replace(/\/$/, "");
// Catalog and seller requests (the 402 and the paid retry included) go through
// a dedicated dispatcher that refuses a TLS chain through a distrusted
// intermediate CA (networks.js).
// Every request names this package in its User-Agent (product token only), so
// the seller can tell which client a call came from. A caller's own
// User-Agent header, when one is set, is kept.
const plainFetch = distrustFetch();
const ownFetch = (input, init = {}) => {
  // The payment wrapper passes a Request and no init: its headers are the base.
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!h.has("user-agent")) h.set("user-agent", `agent402-mcp/${VERSION}`);
  return plainFetch(input, { ...init, headers: h });
};
// AGENT_KEY when it is set, else the key `npx agent402-mcp setup` stored in
// the OS credential store (./key-store.js). Either is read with or without
// its 0x prefix and surrounding whitespace (./wallet-key.js).
const KEY_DIR = configDir();
const STORED_KEY = String(process.env.AGENT_KEY || "").trim() ? "" : (() => {
  try { return readStoredKey({ kind: keyStoreKind(), dir: KEY_DIR }) || ""; } catch { return ""; }
})();
const AGENT_KEY = String(process.env.AGENT_KEY || "").trim() ? process.env.AGENT_KEY : STORED_KEY;
// The name a key error gives: the variable, or the stored key.
const AGENT_KEY_NAME = STORED_KEY ? "the wallet key stored by `npx agent402-mcp setup` (run it again)" : "AGENT_KEY";
// Solana secret key: base58 string (Phantom/solana-keygen export) or a JSON
// byte array. Either key alone enables paid calls; with both, the buyer can
// settle on whichever chain the seller offers (EVM accepts are tried first).
const SOLANA_AGENT_KEY = process.env.SOLANA_AGENT_KEY || "";
const HAS_WALLET = Boolean(AGENT_KEY || SOLANA_AGENT_KEY);
// A prepaid credits key (no wallet), already issued or bought where the
// service sells them (creditsSale() below reads which).
// Sent as Authorization: Bearer on every catalog call; the server debits the
// list price only on a successful (200) call and returns X-Credits-Balance.
const CREDITS_KEY = (process.env.AGENT402_CREDITS_KEY || "").trim();
// Listed with a wallet: a credits key does not pay routes that buy from an
// outside seller (prepaid credits are spent only on Agent402's own services).
const SHOW_ROUTER = HAS_WALLET || process.env.AGENT402_SHOW_ROUTER === "1";
const HIDDEN_WITHOUT_WALLET = new Set(["router.execute", META_MCP_NAMES.list_top_sellers]);
const HAS_CREDITS = /^a402_[A-Za-z0-9_-]{32,64}$/.test(CREDITS_KEY);
// The secrets this process holds never leave it in text: every tool result,
// every protocol error and every console line passes through redactSecrets,
// which replaces each configured key (and the spellings a library may print
// it in: without its 0x prefix, in either case, a byte array without spaces)
// with [redacted]. Key parsing also throws fixed messages that name the
// variable only (walletKeyError), since a parser's own message can quote its
// input.
const SECRET_FORMS = (() => {
  const out = new Set();
  for (const raw of [AGENT_KEY, SOLANA_AGENT_KEY, CREDITS_KEY]) {
    const v = String(raw || "").trim();
    if (v.length < 8) continue;
    out.add(v);
    // The key as the signer reads it (quotes and 0x prefix dropped).
    const k = raw === AGENT_KEY ? evmKeyOrNull(v) : null;
    if (k) { out.add(k); out.add(k.slice(2)); out.add(k.slice(2).toUpperCase()); }
    const hex = v.replace(/^0x/i, "");
    if (/^[0-9a-f]+$/i.test(hex) && hex.length >= 8) { out.add(hex); out.add(hex.toLowerCase()); out.add(hex.toUpperCase()); }
    if (v.startsWith("[")) out.add(v.replace(/\s+/g, ""));
  }
  return [...out].sort((a, b) => b.length - a.length);
})();
function redactSecrets(text) {
  let t = String(text);
  for (const f of SECRET_FORMS) if (t.includes(f)) t = t.split(f).join("[redacted]");
  return t;
}
/** A copy of a tool result (or any JSON value) with every string redacted. */
function redactDeep(v, depth = 0) {
  if (!SECRET_FORMS.length) return v;
  if (typeof v === "string") return redactSecrets(v);
  if (depth > 64 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, depth + 1);
  return out;
}
/** A handler whose answer, and whose thrown error's message, are redacted. */
const redacted = (handler) => async (req, extra) => {
  try {
    return redactDeep(await handler(req, extra));
  } catch (e) {
    if (SECRET_FORMS.length && e && typeof e.message === "string") {
      try { e.message = redactSecrets(e.message); if (typeof e.stack === "string") e.stack = redactSecrets(e.stack); } catch { /* a frozen error */ throw new Error(redactSecrets(e.message)); }
    }
    throw e;
  }
};
// Every console line, a library's included, is redacted before it is written.
if (SECRET_FORMS.length) {
  for (const m of ["log", "info", "warn", "error", "debug", "trace"]) {
    const orig = console[m].bind(console);
    console[m] = (...a) => orig(redactSecrets(format(...a)));
  }
}
// walletKeyError (./wallet-key.js) is a fixed error for a key that does not
// parse: the variable's name and the expected form, never the parser's
// message (it can quote the value).

// Slow paid routes (async.recommended on their /api/pricing row) are sent with
// Prefer: respond-async and collected from their job link (./async-job.js).
// AGENT402_ASYNC=off waits on the connection instead; =always uses a job on
// every route that runs as one. AGENT402_ASYNC_TIMEOUT_MS bounds the wait.
const ASYNC_MODE = (() => { const v = String(process.env.AGENT402_ASYNC || "auto").trim().toLowerCase(); return v === "off" || v === "false" ? false : v === "always" || v === "true" ? true : "auto"; })();
const ASYNC_TIMEOUT_MS = Number(process.env.AGENT402_ASYNC_TIMEOUT_MS) > 0 ? Number(process.env.AGENT402_ASYNC_TIMEOUT_MS) : DEFAULT_ASYNC_TIMEOUT_MS;
// Version comes from package.json, the serverInfo self-report drifted from
// the published version once (0.11.5 vs 0.12.1) because this was a hardcoded
// string bumped by hand. Reading the manifest makes drift impossible.
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// Spend controls, enforced on the payment that is signed (see getPayFetch), so
// a confused or runaway model cannot drain the wallet it was handed. The
// per-call ceiling is on by default at $5, which covers every fixed price in
// the Agent402 catalog (mcp/test.js and scripts/test-package-cap-defaults.js
// check it still does); `0` or `off` turns it off. The session budget is
// opt-in: unset, empty or `off` is no session cap. A value that does not read
// as a USD amount (text, a negative number, for the per-call ceiling an empty
// string) keeps the default and is named on stderr, so a typo never removes
// the per-call ceiling. A call a cap refuses names the setting to raise.
const DEFAULT_MAX_PER_CALL_USD = 5;
const DEFAULT_BUDGET_USD = Infinity;
const capFromEnv = (name, def, { zeroIsOff = false } = {}) => {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return def;
  const original = String(process.env[name]);
  const raw = original.trim().toLowerCase();
  if (raw === "" && !zeroIsOff) return def;
  if (raw === "off") return Infinity;
  const n = raw === "" ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return n === 0 && zeroIsOff ? Infinity : n;
  console.error(`[agent402-mcp] ${name}=${original.length <= 16 ? JSON.stringify(original) : "(a long value, not shown)"} is not a USD amount${zeroIsOff ? ", 0" : ""} or "off"; keeping the default (${def === Infinity ? "no cap" : `$${def} per call`})`);
  return def;
};
const MAX_PER_CALL = capFromEnv("AGENT402_MAX_PER_CALL", DEFAULT_MAX_PER_CALL_USD, { zeroIsOff: true });
const BUDGET = capFromEnv("AGENT402_BUDGET", DEFAULT_BUDGET_USD);
let spentUsd = 0;
// Daily and monthly caps that hold across restarts (./spend-ledger.js): what
// this process confirms as spent is also written to the ledger file while
// either cap is set.
const LEDGER = ledgerFromEnv({ dir: KEY_DIR, warn: (m) => console.error(`[agent402-mcp] ${m}`) });
/** What the daily and monthly caps still allow; 0 when the ledger cannot be read. */
const ledgerLeft = () => { try { return LEDGER.leftUsd(); } catch { return 0; } };
/** Count confirmed spend in this session and in the ledger. */
function addSpent(usd) {
  spentUsd += usd;
  try { LEDGER.record(usd); } catch (e) { console.error(`[agent402-mcp] could not write the spend ledger: ${e.message}`); }
}
// Signed payments that were sent without a confirmed answer (an error status,
// a dropped connection, a redirect, a job still running). The seller holds a
// signed authorization it may still redeem, so the amount counts against the
// session budget for the rest of the session, beside what was spent.
// The default host (DEFAULT_URL, matched by exact origin) settles a payment
// only on an answer below 400, so a sent payment it answered with an error
// status can be redeemed only until its authorization expires: that hold ends
// at the signed validBefore plus HOLD_SLACK_MS, or OWN_HOST_BLIND_HOLD_MS after
// the answer when the payload names no readable expiry.
const HOLD_SLACK_MS = 10 * 60 * 1000;
const OWN_HOST_BLIND_HOLD_MS = 15 * 60 * 1000;
const DEFAULT_ORIGIN = new URL(DEFAULT_URL).origin;
const holds = []; // [{ usd, until }], until Infinity = the rest of the session
const holdPayment = (usd, until = Infinity) => { holds.push({ usd, until }); };
const heldNow = () => { const now = Date.now(); let t = 0; for (const h of holds) if (h.until > now) t += h.usd; return t; };
/** When a sent payload can no longer settle plus the clock slack: an EIP-3009
 *  validBefore or a Permit2 deadline, in seconds, never later than
 *  MAX_VALIDITY_SECONDS from now (the signing guard refuses to send a payload
 *  valid for longer); null when none is readable. */
function signedValidUntilMs(paymentPayload, nowMs = Date.now()) {
  const v = signedExpirySeconds(paymentPayload);
  if (v == null || !Number.isFinite(v)) return null;
  return Math.min(v * 1000, nowMs + MAX_VALIDITY_SECONDS * 1000) + HOLD_SLACK_MS;
}
// Wallet calls in flight, each holding what it may sign until it settles or
// fails, so concurrent calls cannot each pass against the same budget. The
// signing guard reads the one being signed from signCtx.
const pendingSpend = new Set();
const signCtx = new AsyncLocalStorage();
const pendingUsd = (except = null) => { let t = 0; for (const e of pendingSpend) if (e !== except) t += e.usd; return t; };
/** The most the payment being signed may ask for: the per-call cap and what is
 *  left of the session budget after every other call in flight. */
function signAllowance() {
  const others = heldNow() + pendingUsd(signCtx.getStore() || null);
  return Math.max(0, Math.min(MAX_PER_CALL, BUDGET - spentUsd - others, ledgerLeft() - others));
}

const DEFAULT_CURATED = [
  // Flagship demand set, keep aligned with src/mcp-flagship.js FLAGSHIP_SLUGS.
  // Search/answer is the front door; long tail stays behind catalog.search/catalog.call.
  "search", "answer", "search-news", "render",
  "stock-quote", "transcribe", "memory-read", "memory-write",
  // Present only on hosts running the decide service; skipped elsewhere.
  "decide", "decide-execute",
];

// stdout is the MCP protocol channel, all logging goes to stderr.
const log = (...a) => console.error("[agent402-mcp]", ...a);

// ---------------------------------------------------------------------------
// Catalog: built from the service's own machine-readable surfaces.
const catalog = new Map(); // slug -> { slug, method, path, price, description, category, computePayable, inputSchema }
// Skill packs, curated multi-tool workflows, fetched at startup from the
// hosted service so the npm package picks up new packs without a republish.
// Empty if the discovery fetch fails (older services or transient errors);
// prompts/list will just return an empty array in that case.
let skillPacks = [];

// Each surface retries a shed 503 (./discovery.js). A failed pricing or
// openapi read throws, so the catalog is never built from an error body; the
// skill packs are optional and read as empty.
async function loadCatalog() {
  const [pricing, openapi, packs] = await Promise.all([
    getDiscoveryJson("catalog load", `${BASE}/api/pricing`),
    getDiscoveryJson("catalog load", `${BASE}/openapi.json`),
    getDiscoveryJson("skill packs", `${BASE}/api/skill-packs.json`).catch(() => ({ packs: [] })),
  ]);
  if (!Array.isArray(pricing?.endpoints)) throw new Error(`catalog load failed: ${BASE}/api/pricing carried no endpoints list`);
  skillPacks = Array.isArray(packs?.packs) ? packs.packs : [];
  for (const e of pricing.endpoints) {
    const slug = e.slug ?? e.docs?.split("/tools/").pop();
    if (!slug) continue;
    const op = openapi.paths?.[e.path]?.[e.method.toLowerCase()];
    let inputSchema = { type: "object" };
    if (op) {
      if (e.method === "GET") {
        const params = op.parameters ?? [];
        inputSchema = {
          type: "object",
          properties: Object.fromEntries(
            params.map((p) => [p.name, { type: p.schema?.type ?? "string", ...(p.description ? { description: p.description } : {}) }])
          ),
        };
        const required = params.filter((p) => p.required).map((p) => p.name);
        if (required.length) inputSchema.required = required;
      } else {
        const body = op.requestBody?.content?.["application/json"]?.schema;
        if (body) inputSchema = { type: "object", properties: body.properties ?? {}, ...(body.required?.length ? { required: body.required } : {}) };
      }
    }
    catalog.set(slug, {
      slug,
      method: e.method,
      path: e.path,
      price: e.price,
      description: e.description,
      category: e.category,
      computePayable: !!e.computePayable,
      async: e.async && typeof e.async === "object" ? e.async : null,
      inputSchema,
    });
  }
  return pricing;
}

// ---------------------------------------------------------------------------
// Payment: USDC via x402 when a key is configured, else proof-of-work.
let payFetchPromise;
function getPayFetch() {
  payFetchPromise ??= (async () => {
    const { x402Client } = await import("@x402/core/client");
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const client = new x402Client();
    // This package's guard (./known-assets.js) holds every signature to
    // AGENT402_MAX_PER_CALL and what is left of AGENT402_BUDGET, priced from
    // known assets only. It replaces the library's default control, which
    // allows only that library's default assets (so no USDG on Robinhood
    // Chain) under a fixed $1 cap.
    client.setSpendControls?.(false);
    guardSigning(client, {
      allowance: signAllowance,
      onSign: (usd) => { const e = signCtx.getStore(); if (e) { e.usd = usd; e.signed = true; } },
      onRefuse: (detail) => { const e = signCtx.getStore(); if (e) e.refusal = detail; },
    });
    // Registered after the guard's check of the signed amount, so it runs only
    // for a payload about to be sent: from here the payment is outstanding.
    // The payload is kept, so a payment the seller took before a run that
    // failed can be sent once more as it was (never signed again).
    client.onAfterPaymentCreation(async ({ paymentPayload } = {}) => { const e = signCtx.getStore(); if (e && e.signed) { e.sent = true; e.until = signedValidUntilMs(paymentPayload); e.payload = paymentPayload || null; } });
    if (AGENT_KEY) {
      const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
      const { privateKeyToAccount } = await import("viem/accounts");
      registerExactEvmScheme(client, { signer: evmAccount(privateKeyToAccount) });
    }
    if (SOLANA_AGENT_KEY) {
      const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
      registerExactSvmScheme(client, { signer: await solanaSigner() });
    }
    // AGENT402_NETWORKS restricts + orders which chains this buyer will pay
    // on (e.g. "robinhood" settles USDG on chain 4663; the accept carries the
    // asset + EIP-712 domain, so the EVM signer needs no special handling).
    // Without it the client effectively always picks Base on multi-chain
    // sellers, leaving non-default rails unreachable.
    withNetworkPreference(client, parseNetworkPrefs(process.env.AGENT402_NETWORKS));
    return wrapFetchWithPayment(ownFetch, client);
  })();
  return payFetchPromise;
}

// The EVM wallet AGENT_KEY pays from, named on every paid call in the
// X-Agent402-Wallet header with a fresh proof that this key holds it
// (X-Agent402-Wallet-Proof: unix seconds and the key's EIP-191 signature over
// the server's host name, the route, the wallet and those seconds), so a
// server that prices a returning wallet lower can quote it on that call. The
// signed retry resends both. Null without an EVM key or when the key is
// malformed (the paid path reports that itself); never sent on a free call.
let walletHintPromise = null;
function walletHint() {
  walletHintPromise ??= (async () => {
    if (!AGENT_KEY) return null;
    try { const { privateKeyToAccount } = await import("viem/accounts"); return evmAccount(privateKeyToAccount); } catch { return null; }
  })();
  return walletHintPromise;
}
/** The text the wallet signs for one host and route at `time` (unix seconds). */
function walletProofMessage({ host, route, wallet, time }) {
  return `Agent402 returning-wallet price\nhost: ${String(host).toLowerCase()}\nroute: ${route}\nwallet: ${String(wallet).toLowerCase()}\ntime: ${time}`;
}
/** The headers a paid call to `tool` adds for its wallet hint and proof ({} when there is none). */
async function walletHintHeaders(tool) {
  const account = await walletHint();
  if (!account) return {};
  try {
    const time = String(Math.floor(Date.now() / 1000));
    const route = `${String(tool.method || "POST").toUpperCase()} ${tool.path}`;
    const signature = await account.signMessage({ message: walletProofMessage({ host: new URL(BASE).hostname, route, wallet: account.address, time }) });
    return { "X-Agent402-Wallet": account.address, "X-Agent402-Wallet-Proof": `${time}.${signature}` };
  } catch { return {}; }
}

/** The viem account for AGENT_KEY, or walletKeyError. */
function evmAccount(privateKeyToAccount) {
  const key = normalizeEvmKey(AGENT_KEY, AGENT_KEY_NAME);
  try { return privateKeyToAccount(key); } catch { throw walletKeyError(AGENT_KEY_NAME); }
}

// @solana/kit KeyPairSigner from SOLANA_AGENT_KEY, base58 64-byte secret key
// (Phantom / solana-keygen export) or a JSON byte array ([12,34,…]).
let solanaSignerPromise;
function solanaSigner() {
  solanaSignerPromise ??= (async () => {
    const { createKeyPairSignerFromBytes, getBase58Encoder } = await import("@solana/kit");
    const raw = SOLANA_AGENT_KEY.trim();
    try {
      const bytes = raw.startsWith("[")
        ? Uint8Array.from(JSON.parse(raw))
        : new Uint8Array(getBase58Encoder().encode(raw));
      return await createKeyPairSignerFromBytes(bytes);
    } catch {
      throw walletKeyError("SOLANA_AGENT_KEY", "a base58 or JSON byte-array 64-byte Solana secret key");
    }
  })();
  return solanaSignerPromise;
}

function walletRequiredText(tool) {
  return [
    `"${tool.slug}" costs ${tool.price}/call and requires a USDC wallet (it is not eligible for the proof-of-work tier).`,
    `To enable it: run \`npx agent402-mcp setup\` once to store the key of an EVM wallet funded with USDC on Base`,
    `(a Base payment needs no ETH) in your OS keychain, or set AGENT_KEY on this MCP server to that hex private key;`,
    `and/or set SOLANA_AGENT_KEY to the base58 secret key of a Solana wallet funded with USDC on Solana.`,
    `Payment is per call via the x402 protocol: no signup or API key.`,
    `Hold a prepaid credits key? Set AGENT402_CREDITS_KEY to the a402_ key and it pays per successful call on Agent402's own services (${BASE}/credits says whether packs are on sale).`,
    `Pricing and details: ${BASE}/tools/${tool.slug}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// What THIS call will actually be asked to pay.
//
// The catalog price is the ROUTE's list price, and it is not always the amount
// in the challenge: a route may quote per request from the body (a token-
// metered route, or a chat route priced by the model named in it). A cap
// enforced against the list price is therefore not a cap at all, so both paid
// paths read the amount out of the 402 before spending anything.
//
// The preflight carries no payment header and no credits key, so it can only
// ever draw an unpaid 402 - it never signs and never debits. Only the credits
// path sends one: it has no signing step, so the preflight's quote is what its
// caps are checked against. The wallet path sends none; its caps hold at
// signing (guardSigning in getPayFetch). Only run when a ceiling is
// configured: with none, the number changes nothing and the round trip is
// pure cost.
const CAPS_CONFIGURED = Number.isFinite(MAX_PER_CALL) || Number.isFinite(BUDGET) || LEDGER.enabled;

/** The accepts array, at the top level or under the envelope keys sellers wrap it in. */
function acceptsOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.accepts) && obj.accepts.length) return obj.accepts;
  for (const k of ["payment", "x402", "paymentRequired", "payment_required"]) {
    const nested = obj[k];
    if (nested && typeof nested === "object" && Array.isArray(nested.accepts) && nested.accepts.length) return nested.accepts;
  }
  return null;
}

/** The quoted price for this request, or `listUsd` when no 402 can be read.
 *  x402 v2 carries the challenge base64 in the PAYMENT-REQUIRED header and
 *  leaves the body `{}`; v1 sellers put it in the body. Header first.
 *
 *  Each accept is priced from the known-asset table (./known-assets.js), never
 *  from a decimals value the seller sends. The credits gate debits the route's
 *  own quote, and no accept is below it (a chain premium or price floor only
 *  raises an accept), so the cheapest known accept is the price: counting the
 *  dearest would charge the budget for another chain's floor. */
async function quotedUsd(url, init, listUsd) {
  if (!CAPS_CONFIGURED) return { usd: listUsd };
  let q = null;
  try {
    const pre = await ownFetch(url, init);
    if (pre.status !== 402) return { usd: listUsd };
    const header = pre.headers.get("payment-required");
    if (header) {
      try { q = quoteOf(acceptsOf(JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")))); } catch { q = null; }
    }
    if (!q) {
      let body = null; try { body = await pre.json(); } catch { body = null; }
      q = quoteOf(acceptsOf(body));
    }
  } catch { return { usd: listUsd }; /* no readable 402: the advertised price */ }
  if (!q || q.min == null) return { usd: listUsd };
  // Larger of the two: an understated catalog must not lower the ceiling.
  return { usd: Math.max(listUsd, q.min) };
}

// A refused call's tool text. A 402 body from an x402 v2 seller may also carry
// the whole PaymentRequired offer (this server copies its PAYMENT-REQUIRED
// header into the body), which is kilobytes of accepts and extension schemas
// an agent cannot act on in text. Keep the refusal's own fields (error,
// reason, hint, retry) and say where the offer is; any other body is returned
// as it came.
/** True when a failed paid answer says its payment was settled before the
 *  call ran (charged: true, retry: "same-payment"). Read from a copy. */
async function settledFirstFailure(res) {
  try {
    const body = typeof res?.clone === "function" ? await res.clone().json() : null;
    return !!body && typeof body === "object" && body.charged === true && body.retry === "same-payment";
  } catch { return false; }
}
/** The payment header that carries `payload` as it was signed, or null. */
async function paymentHeaderFor(payload) {
  if (!payload || typeof payload !== "object") return null;
  try {
    const { encodePaymentSignatureHeader } = await import("@x402/core/http");
    return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
  } catch { return null; }
}

function failureText(status, text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return text; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.x402Version !== "number") return text;
  const { x402Version: _v, resource: _r, accepts, extensions: _e, ...rest } = doc;
  return JSON.stringify({ ...rest, status, paymentOptions: Array.isArray(accepts) ? accepts.length : 0, note: "The full offer is in the PAYMENT-REQUIRED header of this 402." });
}

/** A job's progress as MCP notifications/progress, when the caller asked for
 *  progress (a progressToken on the tools/call). Progress only ever rises. */
function progressNotifier(req, extra) {
  const token = req?.params?._meta?.progressToken ?? extra?.mcpReq?._meta?.progressToken;
  // SDK v2 hands handlers ctx.mcpReq.notify; v1 handed extra.sendNotification.
  const send = typeof extra?.mcpReq?.notify === "function" ? (n) => extra.mcpReq.notify(n)
    : typeof extra?.sendNotification === "function" ? (n) => extra.sendNotification(n) : null;
  if (token === undefined || token === null || !send) return null;
  let last = -1;
  return (doc) => {
    const pct = Number.isFinite(doc?.progress) ? Math.round(doc.progress * 100) : 0;
    // MCP requires progress to increase with each notification.
    if (pct <= last) return;
    const value = pct;
    last = value;
    const eta = Number.isFinite(doc?.etaSeconds) ? `, about ${doc.etaSeconds} s left` : "";
    const message = `${jobState(doc) || "running"}${doc?.stage ? `: ${doc.stage}` : ""}${doc?.steps ? ` (${doc.steps.done} of ${doc.steps.total} steps)` : ""}${doc?.progressEstimated ? " (estimated)" : ""}${eta}`;
    send({ method: "notifications/progress", params: { progressToken: token, progress: value, total: 100, message } }).catch(() => {});
  };
}

function isRedirect(r) {
  return r?.type === "opaqueredirect" || (r?.status >= 300 && r?.status < 400);
}

async function callEndpoint(tool, args = {}, { onProgress = null } = {}) {
  const url = new URL(`${BASE}${tool.path}`);
  const init = { method: tool.method, headers: { Accept: "application/json" } };
  // A slow route runs as a job (./async-job.js): the paid call asks for one,
  // and the job link is polled (free) until the answer is ready.
  // With async off, a route that needs a header either way says how long to
  // wait (async.preferWait), so the call waits on the connection instead.
  const asyncHeaders = shouldRequestAsync(tool.async, ASYNC_MODE) ? { Prefer: "respond-async" }
    : typeof tool.async?.preferWait === "string" && /^wait=\d+$/.test(tool.async.preferWait) ? { Prefer: tool.async.preferWait } : {};
  const collect = (r) => awaitJob(r, { baseUrl: BASE, fetchImpl: ownFetch, timeoutMs: ASYNC_TIMEOUT_MS, onProgress, slug: tool.slug });
  if (tool.method === "GET") {
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args);
  }

  // A request that can carry a payment never follows a redirect: followed, it
  // would pay another origin's 402, or forward a signature already made to
  // another host, and return that host's answer as this tool's.
  const paidInit = { ...init, redirect: "manual" };
  const redirectRefusal = (r) => {
    const loc = r.headers.get("location");
    const to = loc ? new URL(loc, url).href : null;
    return { content: [{ type: "text", text: `Refused: ${url.href} answered a paid call to "${tool.slug}" with HTTP ${r.status || "redirect"}${to ? ` pointing to ${to}` : ""}. Paid requests never follow redirects${to ? `; if that is the address you meant, set AGENT402_URL to ${new URL(to).origin}` : ""}.` }], isError: true };
  };

  let res;
  let heldNote = "";
  // A paid call the server served under its first-call allowance: nothing
  // was charged, so it counts against no cap (firstCallGrant).
  let freeGrant = false;
  if (!HAS_WALLET && HAS_CREDITS) {
    // Credits key: same budget guards as the wallet path, against the same
    // number - the credits gate holds and debits what the 402 quotes for THIS
    // body, not the route's list price.
    const listUsd = parseFloat(String(tool.price).replace(/[^0-9.]/g, "")) || 0;
    const { usd: price } = await quotedUsd(url, paidInit, listUsd);
    if (price > MAX_PER_CALL) {
      return { content: [{ type: "text", text: `Refused: "${tool.slug}" is quoted $${price} for this request${price !== listUsd ? ` (list price ${tool.price})` : ""}, above the AGENT402_MAX_PER_CALL cap of $${MAX_PER_CALL}. Raise AGENT402_MAX_PER_CALL, or set it to 0 or off, on this MCP server to allow it.` }], isError: true };
    }
    if (spentUsd + price > BUDGET) {
      return { content: [{ type: "text", text: `Refused: session budget exhausted ($${spentUsd.toFixed(4)} of $${BUDGET} spent; "${tool.slug}" is quoted $${price} for this request). Raise AGENT402_BUDGET (or set it to off) on this MCP server to continue.` }], isError: true };
    }
    const capRefusal = LEDGER.refusal(price, tool.slug);
    if (capRefusal) return { content: [{ type: "text", text: capRefusal }], isError: true };
    try {
      const first = await ownFetch(url, { ...paidInit, headers: { ...init.headers, ...asyncHeaders, Authorization: `Bearer ${CREDITS_KEY}` } });
      if (isRedirect(first)) return redirectRefusal(first);
      res = await collect(first);
    }
    catch (e) { if (e instanceof AsyncJobPendingError) { addSpent(price); return pendingJobResult(tool, e); } throw e; }
    if (res.ok) addSpent(price);
    if (res.status === 402) {
      let body = {}; try { body = await res.clone().json(); } catch { /* plain */ }
      // The refusal carries a topup link only while the service sells credits;
      // otherwise its note says so and names where to pay per call instead.
      const sale = creditsSale();
      const next = body.topup ? `Top up at ${body.topup}.` : body.topupNote ? `${body.topupNote}${body.pay ? ` (${body.pay})` : ""}` : sale.buy ? `Top up at ${sale.buy}.` : `${sale.note[0].toUpperCase()}${sale.note.slice(1)}.`;
      return { content: [{ type: "text", text: `Credits refused for "${tool.slug}": ${body.error || "payment required"}${body.balanceUsd != null ? ` (balance $${body.balanceUsd})` : ""}. ${next}` }], isError: true };
    }
  } else if (HAS_WALLET) {
    // The signing guard (installed on every key-built client, getPayFetch)
    // holds the payment that is signed to the caps and refuses an asset it
    // cannot price, so no unpaid preflight is sent: the paid request's own 402
    // is the one quote, read once, at signing. The list price is checked here
    // first only because it costs no request: the quote is never below it for
    // the cap's purposes (an understated catalog must not lower the ceiling).
    const price = parseFloat(String(tool.price).replace(/[^0-9.]/g, "")) || 0;
    if (price > MAX_PER_CALL) {
      return {
        content: [{ type: "text", text: `Refused without paying: "${tool.slug}" lists at ${tool.price}, above the AGENT402_MAX_PER_CALL cap of $${MAX_PER_CALL}. Raise AGENT402_MAX_PER_CALL, or set it to 0 or off, on this MCP server to allow it.` }],
        isError: true,
      };
    }
    const inFlight = pendingUsd();
    const heldUsd = heldNow();
    if (spentUsd + heldUsd + inFlight + price > BUDGET) {
      return {
        content: [{ type: "text", text: `Refused without paying: session budget exhausted ($${spentUsd.toFixed(4)} of $${BUDGET} spent${heldUsd ? `, $${heldUsd.toFixed(4)} held for sent payments whose outcome is unknown` : ""}${inFlight ? `, $${inFlight.toFixed(4)} in flight` : ""}; "${tool.slug}" lists at ${tool.price}). Raise AGENT402_BUDGET (or set it to off) on this MCP server, or restart it, to continue.` }],
        isError: true,
      };
    }
    const capRefusal = LEDGER.refusal(price, tool.slug, { otherUsd: heldUsd + inFlight });
    if (capRefusal) return { content: [{ type: "text", text: capRefusal }], isError: true };
    const payFetch = await getPayFetch();
    // Held until the call settles or fails; the guard replaces `usd` with the
    // amount it lets the wallet sign.
    const entry = { usd: price, signed: false, sent: false, refusal: null, payload: null };
    pendingSpend.add(entry);
    let hintHeaders = {};
    try {
      hintHeaders = await walletHintHeaders(tool);
      const first = await signCtx.run(entry, () => payFetch(url, { ...paidInit, headers: { ...init.headers, ...asyncHeaders, ...hintHeaders } }));
      if (isRedirect(first)) {
        pendingSpend.delete(entry);
        // A signature already sent leaves that payment's outcome unknown, so
        // it is held against the session budget.
        if (entry.sent) holdPayment(entry.usd);
        return redirectRefusal(first);
      }
      res = await collect(first);
    }
    catch (e) {
      pendingSpend.delete(entry);
      // Once a payment was sent, any failure (a job still running, a dropped
      // connection) leaves its authorization redeemable, so it is held.
      if (entry.sent) holdPayment(entry.usd);
      if (e instanceof AsyncJobPendingError) return pendingJobResult(tool, e);
      if (entry.refusal && !entry.sent) return signingRefusal(tool, entry.refusal);
      throw e;
    }
    pendingSpend.delete(entry);
    // A payment the seller settled BEFORE the call ran, whose run then
    // failed (the body says charged: true and retry: "same-payment"): the
    // same payment is sent once more, as it was signed, and the seller runs
    // it at no further charge. Its amount counts once, as spent.
    let takenFirst = false, resent = false;
    if (entry.sent && res.status >= 400 && await settledFirstFailure(res)) {
      takenFirst = true;
      const header = await paymentHeaderFor(entry.payload);
      if (header) {
        resent = true;
        try { res = await collect(await ownFetch(url, { ...paidInit, headers: { ...init.headers, ...asyncHeaders, ...hintHeaders, ...header } })); }
        catch (e) { addSpent(entry.usd); if (e instanceof AsyncJobPendingError) return pendingJobResult(tool, e); throw e; }
      }
    }
    // A sent payment is spent when the server confirms settlement (payment
    // receipt header) or answers 2xx; any other answer leaves the signed
    // authorization with the seller, so it is held, never released.
    if (entry.sent && takenFirst) {
      addSpent(entry.usd);
      if (!res.ok) heldNote = ` The payment of $${entry.usd} was taken before the call ran, so it counts as spent against AGENT402_BUDGET and is owed back, refunded after on-chain proof${resent ? "; the same payment, sent once more, failed too" : "; sending the same payment again runs the call at no further charge"}.`;
    } else if (entry.sent && firstCallGrant(res)) {
      // Served under the first-call allowance: the server verified the
      // payment and did not settle it, so nothing was spent.
      freeGrant = true;
    } else if (entry.sent) {
      if (res.headers.get("payment-response") || res.headers.get("x-payment-response") || res.ok) addSpent(entry.usd);
      else if (res.status >= 400 && url.origin === DEFAULT_ORIGIN) {
        // The default host did not settle it: held until it expires unused.
        const until = entry.until ?? Date.now() + OWN_HOST_BLIND_HOLD_MS;
        holdPayment(entry.usd, until);
        heldNote = ` A payment of $${entry.usd} was sent with this request and ${new URL(DEFAULT_URL).host} does not settle a failed answer: it stays held against AGENT402_BUDGET until its authorization expires unused (${new Date(until).toISOString()}), then is released, never charged.`;
      } else { holdPayment(entry.usd); heldNote = ` A payment of $${entry.usd} was sent with this request, so its outcome is unknown: it stays held against AGENT402_BUDGET for this session.`; }
    }
  } else if (tool.computePayable) {
    // No wallet: pay with compute up front, solving before the call skips the
    // 402 round-trip entirely (challenges are single-use and tool-scoped).
    const challenge = await getDiscoveryJson(`proof-of-work challenge for "${tool.slug}"`, `${BASE}/api/pow/challenge?slug=${encodeURIComponent(tool.slug)}`);
    // Solved on a worker thread (./pow-solver.js), so this server keeps
    // answering the client while it searches; a difficulty above 28 bits is
    // refused rather than searched.
    const nonce = await solvePowAsync(challenge);
    if (typeof challenge.token !== "string" || !challenge.token) throw new Error(`the proof-of-work challenge for "${tool.slug}" carried no token`);
    res = await ownFetch(url, { ...init, headers: { ...init.headers, "X-Pow-Solution": `${challenge.token}:${nonce}` } });
  } else {
    return { content: [{ type: "text", text: walletRequiredText(tool) }], isError: true };
  }

  const out = await answerOf(tool, res, heldNote);
  if (freeGrant && !out.isError) out.content = [...out.content, { type: "text", text: FIRST_CALL_LABEL }];
  return out;
}

// The server's first-call allowance (src/first-call-allowance.js on the
// default host): a wallet's first paid call on an eligible route is served
// with the header X-Agent402-Allowance: first-call and no settlement receipt.
// Read only on a 2xx answer that carries no PAYMENT-RESPONSE, so a call that
// was settled is always counted.
const FIRST_CALL_LABEL = "One-time free call: this wallet's first paid call was served by the first-call allowance, and its x402 payment was verified and never settled, so nothing was charged and it counts against no spending cap.";
function firstCallGrant(res) {
  return res.ok
    && String(res.headers.get("x-agent402-allowance") || "").trim().toLowerCase() === "first-call"
    && !res.headers.get("payment-response") && !res.headers.get("x-payment-response");
}

// Media answers are written to files (./media-output.js) unless
// AGENT402_MEDIA_INLINE is on; the folder is found once, on the first one.
const MEDIA_INLINE = mediaInline();
// An image this small is also returned inline, so the model sees it.
const INLINE_IMAGE_MAX = inlineImageMaxBytes();
let mediaDir;
function mediaFolder() { mediaDir ??= writableOutputDir(outputDirCandidates()); return mediaDir; }
/** Save `buf` for `tool`, or null when inline is asked for or no folder can be written. */
function trySave(tool, buf, { field = "", contentType } = {}) {
  if (MEDIA_INLINE) return null;
  const dir = mediaFolder();
  if (!dir) return null;
  try { return saveMedia(buf, { dir, slug: tool.slug, field, contentType }); } catch (e) { log(`could not write a media answer to ${dir}: ${e.message}`); return null; }
}
/** The tool result for a bytes answer: a file, or inline when asked (or unwritable). */
function bytesResult(tool, buf, contentType) {
  const type = bareType(contentType) || sniffType(buf) || "application/octet-stream";
  const f = trySave(tool, buf, { contentType: type });
  if (f) {
    const seen = type.startsWith("image/") && buf.length <= INLINE_IMAGE_MAX;
    return {
      content: [...(seen ? [{ type: "image", data: buf.toString("base64"), mimeType: type }] : []), { type: "text", text: savedLine(f) }],
      structuredContent: { slug: tool.slug, result: { contentType: f.contentType, bytes: f.bytes, savedTo: f.path, inline: seen, note: seen ? "The answer was written to this file and is also in the image content block" : "The answer was written to this file; set AGENT402_MEDIA_INLINE=1 to receive it inline" } },
    };
  }
  const data = buf.toString("base64");
  const block = type.startsWith("image/") ? { type: "image", data, mimeType: type }
    : type.startsWith("audio/") ? { type: "audio", data, mimeType: type }
    : { type: "text", text: JSON.stringify({ contentType: type, encoding: "base64", data }) };
  return {
    content: [block],
    structuredContent: { slug: tool.slug, result: { contentType: type, encoding: "base64", note: block.type === "text" ? "Binary payload is base64 in the text content block" : `Binary payload is in the ${block.type} content block` } },
  };
}

/** The tool result for a delivered (or failed) answer. */
async function answerOf(tool, res, heldNote) {
  const contentType = bareType(res.headers.get("content-type"));
  if (res.status < 400 && isBinaryBody(contentType)) return bytesResult(tool, Buffer.from(await res.arrayBuffer()), contentType);
  const text = await res.text();
  if (res.status >= 400) {
    return { content: [{ type: "text", text: failureText(res.status, text) + heldNote }], isError: true };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const structured = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
  // A binary answer collected from a job arrives as { contentType, encoding: "base64", data }.
  if (structured.encoding === "base64" && typeof structured.data === "string" && isBinaryBody(structured.contentType)) {
    return bytesResult(tool, Buffer.from(structured.data, "base64"), structured.contentType);
  }
  // A JSON answer that carries a large base64 media field (an image, audio
  // or video) gets the file's path, size and type in that field instead.
  if (!MEDIA_INLINE && text.length >= 8 * 1024) {
    let extracted = null;
    try { extracted = extractMediaFields(structured, (buf, o) => { const f = trySave(tool, buf, o); if (!f) throw new Error("not saved"); return f; }); } catch { extracted = null; }
    if (extracted && extracted.files.length) {
      return {
        content: [{ type: "text", text: JSON.stringify(extracted.value) }, { type: "text", text: extracted.files.map(savedLine).join("\n") }],
        structuredContent: extracted.value,
      };
    }
  }
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/** The daily and monthly caps for payment.info ({} when neither is set). */
function ledgerControls() {
  if (!LEDGER.enabled) return {};
  try {
    const st = LEDGER.status();
    const one = (c) => c && { capUsd: c.capUsd, spentUsd: c.spentUsd, leftUsd: c.leftUsd, resetsAt: c.resetsAt, setting: c.setting };
    return { ...(st.day ? { daily: one(st.day) } : {}), ...(st.month ? { monthly: one(st.month) } : {}), ledger: LEDGER.file };
  } catch (e) { return { ledgerError: e.message }; }
}

/** The tool result for a payment the signing guard refused. */
function signingRefusal(tool, d) {
  const text = d.reason === "unknown-asset"
    ? `Refused without paying: "${tool.slug}" asked to be paid in an asset this server cannot price (USDC or USDG on a known network), so nothing was signed.`
    : d.reason === "signed-amount" || d.reason === "signed-validity"
    ? `Refused without paying: for "${tool.slug}", ${d.detail}, so the payment was not sent.`
    : d.reason === "validity"
    ? `Refused without paying: for "${tool.slug}", ${d.detail}, so nothing was signed.`
    : `Refused without paying: "${tool.slug}" asked for $${d.priceUsd} on the paid request, above the $${Number(d.allowanceUsd.toFixed(6))} this server may sign (AGENT402_MAX_PER_CALL ${MAX_PER_CALL === Infinity ? "off" : `$${MAX_PER_CALL}`}, AGENT402_BUDGET ${BUDGET === Infinity ? "off" : `$${BUDGET}`} with $${spentUsd.toFixed(4)} spent${LEDGER.summary()}). Nothing was signed; raise the setting that refused it (AGENT402_MAX_PER_CALL also takes 0 or off) on this MCP server to allow it.`;
  return { content: [{ type: "text", text }], isError: true };
}

/** The tool result for a job still running when the wait ended. */
function pendingJobResult(tool, e) {
  return {
    content: [{ type: "text", text: `${tool.slug}: ${e.message}. The call was paid for as a job; payment settles only if the answer is delivered. Poll the job link (free, no payment) for the answer.` }],
    structuredContent: { slug: tool.slug, pending: true, jobUrl: e.jobUrl || null, job: e.job || null },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool search over the full catalog (for everything not exposed first-class).
// Front-door phrase boosts mirror src/find.js applyFrontDoorTerms so stdio
// search_tools agrees with /api/find (package stays dependency-free).
function applyFrontDoorTerms(terms, q) {
  const ql = String(q || "").toLowerCase();
  if (!terms.includes("websearch") && (
    /\b(search\s+the\s+web|web\s+search|search\s+online|google\s+|bing\s+|look\s+up\s+online|find\s+on\s+the\s+web)\b/.test(ql)
  )) {
    // pricing descriptions carry "web search" / "Live web search", boost those.
    terms.push("web", "search");
  }
  if (!terms.includes("answer") && (
    /\b(answer\s+(this\s+)?(question|me)|answer\s+with\s+citations|cited?\s+answer|grounded\s+answer)\b/.test(ql)
  )) {
    terms.push("answer", "citations");
  }
  if (!terms.includes("news") && (
    /\b(latest\s+news|breaking\s+news|news\s+(about|on|for)|headlines|current\s+events)\b/.test(ql)
  )) {
    terms.push("news", "breaking");
  }
}

/** catalog.search's limit: a whole number from 1 to MAX_SEARCH_RESULTS, the
 *  default for anything else (a string that reads as a number counts). */
const MAX_SEARCH_RESULTS = 25;
function searchLimit(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SEARCH_RESULTS) : 10;
}

/** A tool's `params` as an object: a JSON string that encodes an object (a
 *  host that serializes nested arguments sends one) is parsed; anything else
 *  that is not an object is refused with what was expected. */
function paramsObject(raw, where) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: {} };
  if (typeof raw === "object" && !Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v };
    } catch { /* falls through to the refusal */ }
  }
  return { ok: false, text: `${where} "params" must be an object of the tool's inputs, or a JSON string of one (got ${Array.isArray(raw) ? "an array" : typeof raw}).` };
}

function searchTools(query, limit = 10) {
  const q = String(query || "");
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  applyFrontDoorTerms(terms, q);
  const scored = [];
  for (const t of catalog.values()) {
    const slug = t.slug.toLowerCase();
    const hay = `${t.description} ${t.category}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      if (slug.includes(term)) score += 4;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, t]) => ({
    slug: t.slug,
    method: t.method,
    path: t.path,
    price: t.price,
    payment: t.computePayable ? "USDC or free via proof-of-work" : "USDC (wallet required)",
    description: t.description.length > 220 ? `${t.description.slice(0, 220)}…` : t.description,
    inputSchema: t.inputSchema,
  }));
}

// Rank the curated multi-tool skill packs against the same query, so a single
// search_tools call also tells the agent "this looks like a `security-audit`
// or `email-deliverability` job, fetch the whole template via prompts/get".
// Weighted slug/title/tagline/useCase/toolSlugs match, same shape as the
// hosted /api/find ranking, kept inline here so the stdio package stays
// dependency-free. Returns [] when no pack scores above the noise floor.
function rankWorkflows(query, k = 2) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!terms.length || !skillPacks.length) return [];
  const scored = [];
  for (const p of skillPacks) {
    const slug = p.slug.toLowerCase();
    const title = (p.title || "").toLowerCase();
    const tagline = (p.tagline || "").toLowerCase();
    const useCase = (p.useCase || "").toLowerCase();
    const toolSet = new Set((p.toolSlugs || []).map((s) => String(s).toLowerCase()));
    const workflowHay = (p.workflow || []).join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 12;
      else if (slug.includes(term)) score += 5;
      if (title.includes(term)) score += 3;
      if (tagline.includes(term)) score += 2;
      if (useCase.includes(term)) score += 1;
      if (toolSet.has(term)) score += 4;
      if (workflowHay.includes(term)) score += 1;
    }
    if (score >= 4) scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length);
  return scored.slice(0, k).map(([score, p]) => ({
    slug: p.slug,
    title: p.title,
    tagline: p.tagline,
    toolCount: (p.toolSlugs || []).length,
    promptName: p.slug,
    score,
  }));
}

// ---------------------------------------------------------------------------
// MCP wiring
// Initialize instructions mirror src/mcp-flagship.js mcpInitializeInstructions
// (stdio package cannot import src/ when published). Keep tool names listed-only.
// This server lists no demand.request, so its instructions do not name it;
// market.quote is named only while it is listed (the catalog lists
// stock-quote and it is first-class here), so the text is rebuilt after each
// catalog read (syncInstructions) and before the first initialize.
const instructionsFor = (stock) => mcpInitializeInstructions(BASE, { ...hostedConnectorWiresFor(BASE), demand: false, stock });
const INIT_INSTRUCTIONS = instructionsFor(false);

const server = new Server(
  {
    name: "agent402",
    version: VERSION,
    title: "Agent402",
    description: MCP_SERVER_DESCRIPTION,
    websiteUrl: BASE || MCP_SERVER_WEBSITE,
  },
  { capabilities: { tools: {}, prompts: {} }, instructions: INIT_INSTRUCTIONS },
);
/** Point the initialize instructions at what tools/list lists now. */
function syncInstructions() {
  server._instructions = instructionsFor(curated.some((t) => t.slug === "stock-quote"));
}

// Skill packs are exposed as MCP prompts, discoverable in slash menus on any
// MCP-aware client. The list is fetched once at boot in loadCatalog(); the
// per-prompt rendering is delegated to the hosted service so the npm package
// stays thin and prompt text stays canonical with the website at /skills.
server.setRequestHandler("prompts/list", redacted(async () => ({
  prompts: skillPacks.map((p) => ({
    name: p.slug,
    title: p.title,
    description: p.tagline,
    arguments: (p.promptArgs || []).map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required ?? true,
    })),
  })),
})));
server.setRequestHandler("prompts/get", redacted(async (req) => {
  const { name, arguments: args = {} } = req.params;
  const pack = skillPacks.find((p) => p.slug === name);
  if (!pack) throw new Error(`Unknown prompt "${name}". List available with prompts/list.`);
  const url = new URL(`${BASE}/api/skill-packs/${encodeURIComponent(name)}/prompt`);
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const { res, attempts } = await fetchDiscovery(url);
  if (!res.ok) throw new Error(`Failed to render prompt "${name}" from ${BASE}: ${discoveryFailure(url, res, attempts)}`);
  return await res.json();
}));

let curated = [];
let pricingInfo = null;

// Whether the service sells new credits is a switch on the server, read from
// its /api/pricing (credits.onSale); this package cannot see the switch on its
// own, so a buy link is shown only while the catalog read says they are sold,
// and a key already issued keeps working either way.
function creditsSale() {
  const c = pricingInfo?.credits;
  if (c?.onSale === true) return { onSale: true, buy: c.buy || `${BASE}/credits` };
  if (c?.onSale === false) return { onSale: false, note: "new credits are not on sale; a key already issued keeps working" };
  return { onSale: null, note: `whether new credits are sold is read from ${BASE}/api/pricing (credits.onSale); a key already issued keeps working` };
}

// A catalog that could not load at boot (a shed or unreachable service) is
// read again on the next tools/list or tools/call, at most once per
// CATALOG_RETRY_MS, so a session that started during a busy minute recovers
// without a restart.
const CATALOG_RETRY_MS = 30_000;
let catalogRetryAt = 0;
async function ensureCatalog() {
  if (catalog.size > 0 || Date.now() < catalogRetryAt) return;
  catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
  try {
    pricingInfo = await loadCatalog();
    curated = requested.map((slug) => catalog.get(slug)).filter(Boolean);
    syncInstructions();
    log(`catalog: ${catalog.size} tools from ${BASE} on a later read; ${curated.length} first-class`);
  } catch (err) {
    log(`Could not load the catalog from ${BASE}: ${err.message}: next read in ${CATALOG_RETRY_MS / 1000}s`);
  }
}
const withCatalog = (handler) => async (req, extra) => { await ensureCatalog(); return handler(req, extra); };

server.setRequestHandler("tools/list", redacted(withCatalog(async () => {
  // The same hints as the hosted connector (src/mcp-http.js). A host may run
  // a read-only tool without asking its user, so readOnlyHint is true only for
  // a tool that never charges and never writes: the local catalog search,
  // describe and payment info (closed-world), and the free lookups that read
  // the service (catalog.find, sellers.list: open-world). Every tool that can
  // charge is not read-only; catalog.call and router.execute can run a tool
  // that writes, deletes or buys, so they are marked destructive, and
  // memory.write replaces the value a key held.
  const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const NET = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const CALL_PAID = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const tools = curated.map((t) => {
    // verb_noun exposed names (match hosted /mcp). CallTool accepts kebab + plain snake too.
    const name = FLAGSHIP_MCP_NAMES[t.slug] || t.slug.replace(/-/g, "_");
    const ann = t.slug === "memory-write" ? OVERWRITE : NET;
    return {
      name,
      title: t.slug,
      annotations: { title: t.slug, ...ann },
      description: clipToolDescription(`${t.computePayable ? `Paid (${t.price}/call), or free via proof-of-work:` : `Paid (${t.price}/call):`} ${t.description}`),
      inputSchema: t.inputSchema,
      outputSchema: FLAGSHIP_OUTPUT_SCHEMAS[t.slug] || outputSchemaFromExample(null),
    };
  });
  tools.push(
    {
      name: META_MCP_NAMES.search_tools,
      title: "Search the Agent402 tool catalog",
      annotations: { title: "Search the Agent402 tool catalog", ...SAFE },
      description:
        `Keyword search over the Agent402 catalog of 500+ tools (${catalog.size} loaded by this server). Returns matching tools and workflow templates; run one with catalog.call. Pure-CPU tools are free through proof-of-work; the others are paid per call in USDC when a wallet key is set.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you need, e.g. \"search the web for x402\", \"answer a question with citations\", \"convert miles to km\"" },
          limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Max results (default 10, at most ${MAX_SEARCH_RESULTS})` },
        },
        required: ["query"],
      },
      outputSchema: META_OUTPUT_SCHEMAS["catalog.search"],
    },
    {
      name: META_MCP_NAMES.find_tool,
      title: "Resolve a task to the one best Agent402 tool",
      annotations: { title: "Resolve a task to the one best Agent402 tool", ...OPEN },
      description:
        "Resolve a plain-language task to the single best-matching Agent402 tool through the hosted /api/find resolver. Returns { task, matches } with the top pick first. Run the pick with catalog.call and the slug and params it lists. Use catalog.search to compare several candidates.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "What you want to do, e.g. \"search the web for x402 adoption\" or \"convert miles to km\"" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["task"],
      },
      outputSchema: META_OUTPUT_SCHEMAS["catalog.find"],
    },
    {
      name: META_MCP_NAMES.call_tool,
      title: "Run an Agent402 tool",
      annotations: { title: "Run an Agent402 tool", ...CALL_PAID },
      description:
        "Call any Agent402 tool by slug (find slugs with catalog.find or catalog.search). Payment is handled automatically: USDC via x402 if this server has a wallet key, otherwise free proof-of-work on eligible pure-CPU tools (no wallet needed). Wallet-keyed highlights: live search/answer, render, transcribe, memory, and the /v1 LLM gateway tiers.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Tool slug from catalog.search, e.g. \"search\" or \"unit-convert\"" },
          params: { type: ["object", "string"], description: "Tool input parameters, matching the tool's inputSchema (an object, or a JSON string of one)" },
        },
        required: ["slug"],
      },
      outputSchema: META_OUTPUT_SCHEMAS["catalog.call"],
    },
    {
      // Listed as get_payment_info to match hosted /mcp; payment_info stays a CallTool alias.
      name: META_MCP_NAMES.get_payment_info,
      title: "Payment and wallet setup",
      annotations: { title: "Payment and wallet setup", ...SAFE },
      description: "How this MCP server is paying for Agent402 calls (USDC wallet vs proof-of-work), and what that unlocks. Includes Claude Code / Cursor / npm install one-liners.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: META_OUTPUT_SCHEMAS["payment.info"],
    },
    {
      // Pure verb_noun (Smithery Naming). describe_agent402 / about_agent402 stay aliases.
      name: META_MCP_NAMES.describe_server,
      title: "About this Agent402 connector",
      annotations: { title: "About this Agent402 connector", ...SAFE },
      description: "Describe this stdio MCP server: the tools it lists, install commands, free vs paid, and discovery URLs.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: META_OUTPUT_SCHEMAS["server.describe"],
    },
    // Discovery primitive: who's earning USDC on x402 right now? Proxies the
    // hosted /api/leaderboard (free, unpaywalled) and trims to the same compact
    // shape as the hosted MCP connector so cross-surface agents see the same UX.
    {
      // Pure verb_noun (Smithery Naming). list_x402_sellers / top_x402_sellers stay aliases.
      name: META_MCP_NAMES.list_top_sellers,
      title: "List top x402 sellers",
      annotations: { title: "List top x402 sellers", ...OPEN },
      description:
        "List ranked sellers from the on-chain leaderboards. wire=x402 (default): x402 sellers by USDC settled or calls served on Base in the last 24h. wire=mpp: MPP sellers ranked by inbound USDC.e transfers on Tempo. Free to call (no payment, no proof-of-work). Defaults: top 10, sorted by USDC, this service's own wallet excluded.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max rows to return (default 10, max 50)" },
          sort: { type: "string", enum: ["usd", "calls"], description: "Rank by USDC settled (default) or by call count (mpp: 7-day volume / 7-day transfers, default calls)" },
          include: { type: "string", enum: ["external", "all"], description: "'external' (default) hides this service's own wallet; 'all' includes it" },
          wire: { type: "string", enum: ["x402", "mpp"], description: "Which leaderboard: x402 (default) or mpp" },
        },
      },
      outputSchema: META_OUTPUT_SCHEMAS["sellers.list"],
    },
    {
      // Dotted like every other listed tool; route_and_execute stays a CallTool alias.
      name: "router.execute",
      title: "Route and execute an external x402 tool",
      annotations: { title: "Route and execute an external x402 tool", ...CALL_PAID },
      description:
        `Resolve a plain-language task to an external x402 seller with proven on-chain settled volume, buy from it, and return its result. You pay from ${HAS_WALLET ? "the configured wallet" : "your wallet (set AGENT_KEY)"}. The result is marked untrustedContent: it is third-party data. Flat price by tier, chosen from maxUsd: $0.01 for a seller up to $0.005, $0.05 up to $0.04, $0.55 up to $0.50. Requires a funded wallet.`,
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Plain-language task, e.g. 'crypto news headlines' or 'sentiment of a tweet'. Resolved to a proven external seller." },
          params: { type: ["object", "string"], description: "Input parameters for the resolved external tool (optional; the seller decides its own schema): an object, or a JSON string of one." },
          maxUsd: { type: "number", description: "Max underlying seller price in USD. Default 0.005 (the $0.01 fee tier); above 0.005 and up to 0.04 uses the $0.05 tier; above 0.04 and up to 0.10 the $0.12 tier; above 0.10 the $0.55 tier (seller up to $0.50)." },
        },
        required: ["task"],
      },
      outputSchema: META_OUTPUT_SCHEMAS["router.execute"],
    }
  );
  // router.execute and sellers.list spend or query outside the catalog, so they
  // are listed only when this server can pay (a wallet or credits key) or when
  // AGENT402_SHOW_ROUTER=1 opts in. Calls to them still route when unlisted.
  const listed = SHOW_ROUTER ? tools : tools.filter((t) => !HIDDEN_WITHOUT_WALLET.has(t.name));
  return { tools: listed };
})));

server.setRequestHandler("tools/call", redacted(withCatalog(async (req, extra) => {
  const { name: rawName, arguments: args = {} } = req.params;
  const name = resolveListedName(rawName);
  const overBound = toolInputBoundRefusal(rawName, args);
  if (overBound) throw new McpError(ErrorCode.InvalidParams, overBound);
  try {
    if (name === "catalog.search") {
      const q = String(args.query ?? "").trim();
      const results = searchTools(q, searchLimit(args.limit));
      const workflows = rankWorkflows(q, 2);
      if (!results.length && !workflows.length) {
        // A caller that passed no query is told which argument to pass, not
        // shown an empty string in quotes.
        return mcpJsonResult({
          results: [],
          message: q
            ? `No tools matched "${q}". Browse the catalog at ${BASE}/tools or ${BASE}/api/pricing.`
            : `catalog.search needs a "query" argument: what the tool should do (for example "convert miles to kilometers"). Browse the catalog at ${BASE}/tools or ${BASE}/api/pricing.`,
        });
      }
      return mcpJsonResult({
        results,
        ...(workflows.length ? { workflows, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …per-pack args } } returns the full Claude-ready task template." } : {}),
        usage: "catalog.call {\"slug\": …, \"params\": …}",
      });
    }
    if (name === "catalog.find") {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return { content: [{ type: "text", text: "catalog.find requires a 'task' (plain-language description of what you need)." }], isError: true };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 25);
      const url = new URL(`${BASE}/api/find`);
      url.searchParams.set("q", task);
      url.searchParams.set("k", String(limit));
      const { res, attempts } = await fetchDiscovery(url);
      if (!res.ok) {
        return { content: [{ type: "text", text: `catalog.find failed against ${BASE}/api/find: ${discoveryFailure(url, res, attempts)}` }], isError: true };
      }
      const body = await res.json();
      const matches = (body.results || []).map((t) => ({
        slug: t.slug,
        name: t.name,
        price: t.price,
        description: t.description,
        example: t.example,
        required: t.required,
        inputSchema: t.inputSchema,
        callWith: { name: META_MCP_NAMES.call_tool, arguments: { slug: t.slug, params: t.example ?? {} } },
      }));
      return mcpJsonResult({
        task,
        matches,
        results: matches,
        ...(body.packs?.length ? { workflows: body.packs } : {}),
        usage: "Run catalog.call with the chosen {slug, params}.",
      });
    }
    if (name === "payment.info") {
      let address = null;
      if (AGENT_KEY) {
        const { privateKeyToAccount } = await import("viem/accounts");
        try { address = evmAccount(privateKeyToAccount).address; } catch { address = "invalid AGENT_KEY"; }
      }
      let solanaAddress = null;
      if (SOLANA_AGENT_KEY) {
        try { solanaAddress = (await solanaSigner()).address; } catch { solanaAddress = "invalid SOLANA_AGENT_KEY"; }
      }
      const computePayable = [...catalog.values()].filter((t) => t.computePayable).length;
      const sale = creditsSale();
      return mcpJsonResult({
        service: BASE,
        mode: HAS_WALLET ? "usdc" : HAS_CREDITS ? "credits" : "proof-of-work",
        wallet: address,
        walletKeySource: AGENT_KEY ? (STORED_KEY ? "stored key (npx agent402-mcp setup)" : "AGENT_KEY") : null,
        mediaOutput: MEDIA_INLINE ? "inline (AGENT402_MEDIA_INLINE)" : "files in AGENT402_OUTPUT_DIR (default ~/Downloads/agent402, else the OS temp folder)",
        solanaWallet: solanaAddress,
        network: pricingInfo?.payment?.network ?? "base",
        networks: pricingInfo?.payment?.networks ?? undefined,
        tools: catalog.size,
        payableWithCompute: computePayable,
        walletOnly: catalog.size - computePayable,
        workflows: skillPacks.length,
        credits: HAS_CREDITS
          ? { configured: true, how: "a prepaid credits key (Authorization: Bearer a402_...) - every wallet-only tool except the wallet-identity-bound ones (memory, usage, receipts, attest, feedback) and the routes that buy from an outside seller pays from the balance, debited only on a successful call", balance: `${BASE}/api/credits/balance`, onSale: sale.onSale, ...(sale.buy ? { topup: sale.buy } : { note: sale.note }) }
          : { configured: false, how: "a credits key, where sold or already issued, pays per successful call on Agent402's own services (AGENT402_CREDITS_KEY)", onSale: sale.onSale, ...(sale.buy ? { buy: sale.buy } : { note: sale.note }) },
        spendControls: (HAS_WALLET || HAS_CREDITS)
          ? {
              maxPerCallUsd: MAX_PER_CALL === Infinity ? "unlimited" : MAX_PER_CALL,
              sessionBudgetUsd: BUDGET === Infinity ? "unlimited" : BUDGET,
              spentThisSessionUsd: Number(spentUsd.toFixed(6)),
              heldThisSessionUsd: Number(heldNow().toFixed(6)),
              remainingUsd: BUDGET === Infinity ? "unlimited" : Number(Math.max(0, BUDGET - spentUsd - heldNow()).toFixed(6)),
              ...ledgerControls(),
            }
          : "n/a (proof-of-work mode spends CPU, not money)",
        note: HAS_WALLET
          ? "Every tool is available; each call is paid in USDC via x402 from the configured wallet(s) - EVM chains via AGENT_KEY, Solana via SOLANA_AGENT_KEY - within the spend controls above."
          : HAS_CREDITS
            ? "Every tool on Agent402's own services is available; each call is paid from the credits key (AGENT402_CREDITS_KEY), debited only on a successful call, within the spend controls above. The routes that buy from outside sellers (router.execute, seller-payability, decide.execute, the flight tools) and the wallet-identity tools (memory, usage) need a wallet key."
            : `No wallet or credits key configured: ${computePayable} pure-CPU tools are free via proof-of-work; the ${catalog.size - computePayable} network/browser/memory tools need a funded wallet (AGENT_KEY / SOLANA_AGENT_KEY) or a prepaid credits key (AGENT402_CREDITS_KEY).`,
        install: {
          claudeCodeHosted: `claude mcp add --transport http agent402 ${BASE}/mcp`,
          claudeCodeNpm: `claude mcp add agent402 -s user -- npx -y agent402-mcp@${AGENT402_MCP_VERSION}`,
          cursorHosted: { mcpServers: { agent402: { url: `${BASE}/mcp` } } },
          npm: "npx -y agent402-mcp@0.16.0",
          maintainer: "Havok Holdings LLC",
        },
        positioning: `Agent402 is the payment and trust layer for agentic commerce: agents find, pay for and verify every paid call to Agent402, across x402 and MPP, with a signed receipt for each one. 500+ ready tools on the same rails. Flagship search/answer first, the long tail via catalog.find / catalog.search / catalog.call. Agent402 is the applied layer of Agentic Finance: agents that pay and get paid per request over x402 or MPP (Machine Payments Protocol), both on the same 402 - ${BASE}/agentic-finance, ${BASE}/glossary.`,
        ecosystem: "Call sellers.list to see which x402 sellers (any wallet, not just this host) are settling the most USDC (primarily on Base) in the last 24h, or sellers.list with wire=mpp for MPP sellers ranked by on-chain USDC.e transfers on Tempo - discovers the live economy beyond this catalog.",
      });
    }
    if (name === "server.describe") {
      return mcpJsonResult({
        service: BASE,
        connector: "stdio npm package (agent402-mcp)",
        maintainer: "Havok Holdings LLC",
        positioning: `Agent402 is the payment and trust layer for agentic commerce: agents find, pay for and verify every paid call to Agent402, across x402 and MPP, with a signed receipt for each one. 500+ ready tools on the same rails. It is the applied layer of Agentic Finance: software agents that pay and get paid on their own, per request, over x402 or MPP (Machine Payments Protocol) - both answered on the same 402. ${BASE}/agentic-finance, ${BASE}/glossary.`,
        startHere: {
          firstJob: "Search the web and answer questions. Call web.search or web.answer directly, or catalog.find with your task.",
          mode: HAS_WALLET ? "usdc" : HAS_CREDITS ? "credits" : "proof-of-work",
        },
        install: {
          claudeCodeHosted: `claude mcp add --transport http agent402 ${BASE}/mcp`,
          claudeCodeNpm: `claude mcp add agent402 -s user -- npx -y agent402-mcp@${AGENT402_MCP_VERSION}`,
          npm: "npx -y agent402-mcp@0.16.0",
          maintainer: "Havok Holdings LLC",
        },
        tools: catalog.size,
        toolsEvergreen: "500+",
        missingATool: "Call demand.request on the hosted connector, or POST /api/wish.",
        docs: `${BASE}/llms.txt`,
      });
    }
    if (name === "sellers.list" && args.wire === "mpp") {
      // Thin pass-through to /api/mpp-leaderboard (free, unpaywalled), same
      // compact row shape as the hosted connector's wire=mpp branch.
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
      const sort = args.sort === "usd" ? "usd" : "calls";
      const include = args.include === "all" ? "all" : "external";
      const { res, attempts } = await fetchDiscovery(`${BASE}/api/mpp-leaderboard`);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to fetch the MPP leaderboard from ${BASE}: ${discoveryFailure(`${BASE}/api/mpp-leaderboard`, res, attempts)}` }], isError: true };
      }
      const lb = await res.json();
      let board = (Array.isArray(lb.rows) ? lb.rows : []).filter((r) => r.transfers > 0 || (r.d30?.transfers || 0) > 0);
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
        // Seller names/homepages are self-reported third-party content (same
        // F09 rule as the hosted connector): never let a downstream agent read
        // seller copy as an instruction.
        ...(r.self ? {} : { untrustedContent: true }),
      }));
      return mcpJsonResult({
        wire: "mpp",
        measure: "inbound USDC.e transfers on Tempo (chain 4217) to the recipient each seller's live MPP challenge names - a window read plus rolling 7d/30d, a proxy for settlements, not lifetime",
        window: lb.window ? `~${lb.window.approxHours}h (${lb.window.blocks} blocks)` : null,
        asOf: lb.generatedAt || null,
        sort, include,
        totalSellers: Array.isArray(lb.rows) ? lb.rows.length : 0,
        results: rows,
        ...(rows.some((r) => r.untrustedContent) ? { containsUntrustedContent: true } : {}),
        ...(lb.stale ? { note: "Leaderboard is stale or still warming - retry in a few minutes." } : {}),
        source: `${BASE}/api/mpp-leaderboard`,
      });
    }
    if (name === "sellers.list") {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
      const sort = args.sort === "calls" ? "calls" : "usd";
      const include = args.include === "all" ? "all" : "external";
      // /api/leaderboard is free + unpaywalled, so this stays free regardless
      // of payment mode. Honor its query params verbatim so the surface is a
      // thin pass-through, single source of truth for ranking + filtering.
      const url = new URL(`${BASE}/api/leaderboard`);
      url.searchParams.set("top", String(limit));
      url.searchParams.set("sort", sort);
      url.searchParams.set("include", include);
      const { res, attempts } = await fetchDiscovery(url);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to fetch leaderboard from ${BASE}: ${discoveryFailure(url, res, attempts)}` }], isError: true };
      }
      const snap = await res.json();
      // Trim to the same compact row shape the hosted MCP connector returns,
      // cross-surface agents see one mental model. Full row (origins,
      // endpoints, scan metadata) stays accessible at /api/leaderboard.
      // Same untrusted-content marking as the hosted connector: a seller's
      // name/homepage is self-reported external content. `snap.self` (or a
      // row flagged self) is this host's own wallet when the API says so.
      const rows = (snap.leaderboard || []).map((r) => ({
        rank: r.rank,
        name: r.name,
        network: r.network,
        wallet: r.wallet,
        homepage: r.homepage || null,
        callsSettled: r.callsSettled || 0,
        totalUsd: Math.round((r.totalUsd || 0) * 10000) / 10000,
        uniqueBuyers: r.uniqueBuyers || 0,
        ...(r.self ? {} : { untrustedContent: true }),
      }));
      return mcpJsonResult({
        ...(rows.some((r) => r.untrustedContent) ? { containsUntrustedContent: true } : {}),
        window: snap.windowLabel || snap.windowServed || "24h",
        asOf: snap.asOf,
        sort: snap.sortServed || sort,
        include: snap.include || include,
        totalSellers: snap.totalSellers ?? (snap.leaderboard || []).length,
        results: rows,
        ...(snap.warming || snap.scanSkipped ? { note: "Cache is warming: results may be partial. Retry in ~60s." } : {}),
        source: `${BASE}/api/leaderboard`,
      });
    }
    if (name === "router.execute") {
      const task = String(args.task ?? "").trim();
      if (!task) return { content: [{ type: "text", text: "router.execute requires a 'task' (plain-language description of what you need)." }], isError: true };
      const maxUsd = Number(args.maxUsd) > 0 ? Number(args.maxUsd) : 0.005;
      // Pick the CHEAPEST tier whose underlying cap covers maxUsd. The ladder
      // skipped a middle rung once and billed 11x for a mid-priced seller (a
      // $0.02 seller went through the $0.55 tier instead of $0.05).
      // Keep this ordered cheapest-first so a new rung is a one-line insert.
      // A server that does not list a rung yet is served by the next one up.
      const ROUTER_TIERS = [
        { slug: "route-execute", underlyingMaxUsd: 0.005 },
        { slug: "route-execute-plus", underlyingMaxUsd: 0.04 },
        { slug: "route-execute-mid", underlyingMaxUsd: 0.1 },
        { slug: "route-execute-max", underlyingMaxUsd: 0.5 },
      ];
      const slug = ROUTER_TIERS.find((t) => maxUsd <= t.underlyingMaxUsd && catalog.has(t.slug))?.slug || "route-execute-max";
      const tool = catalog.get(slug);
      if (!tool) return { content: [{ type: "text", text: `External routing (${slug}) is not in the catalog from ${BASE} yet. It may be rolling out; retry shortly.` }], isError: true };
      // Body matches the route-execute input schema; include:"external" is what
      // pays an OUTSIDE seller (vs this host's catalog). Paid via callEndpoint.
      const routed = paramsObject(args.params, "router.execute");
      if (!routed.ok) return { content: [{ type: "text", text: routed.text }], isError: true };
      return await callEndpoint(tool, { task, include: "external", maxUsd, ...(Object.keys(routed.value).length ? { params: routed.value } : {}) }, { onProgress: progressNotifier(req, extra) });
    }
    // Curated tools are exposed verb_noun for tools/list consistency, but the
    // real slug is kebab, accept exposed name, plain snake, or raw slug.
    const mcpToSlug = new Map(Object.entries(FLAGSHIP_MCP_NAMES).map(([slug, mcp]) => [mcp, slug]));
    const wanted = name === "catalog.call"
      ? String(args.slug ?? "")
      : (catalog.has(name) ? name
        : mcpToSlug.get(name) || name.replace(/_/g, "-"));
    const tool = catalog.get(wanted);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool slug "${wanted}". Use catalog.search to find the right slug.` }], isError: true };
    }
    let input = args;
    if (name === "catalog.call") {
      const p = paramsObject(args.params, "catalog.call");
      if (!p.ok) return { content: [{ type: "text", text: p.text }], isError: true };
      input = p.value;
    }
    const out = await callEndpoint(tool, input, { onProgress: progressNotifier(req, extra) });
    // call_tool: wrap structuredContent in {slug, result} to match META_OUTPUT_SCHEMAS["catalog.call"]
    // while keeping content text as the native tool JSON.
    if (name === "catalog.call" && !out.isError && out.structuredContent) {
      return {
        content: out.content,
        structuredContent: { slug: tool.slug, result: out.structuredContent },
      };
    }
    return out;
  } catch (err) {
    return { content: [{ type: "text", text: `Agent402 call failed: ${err.message}` }], isError: true };
  }
})));

// ---------------------------------------------------------------------------
try {
  pricingInfo = await loadCatalog();
} catch (err) {
  // Don't hard-exit: starting with an empty catalog still lets the server
  // connect and answer introspection (tools/list), required to pass directory
  // health checks (e.g. Glama) and more resilient if the catalog endpoint is
  // briefly unreachable. The next tools/list or tools/call reads it again
  // (ensureCatalog).
  log(`Could not load the catalog from ${BASE}: ${err.message}: starting with an empty catalog`);
  catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
}
const requested = (process.env.AGENT402_TOOLS || DEFAULT_CURATED.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
curated = requested.map((slug) => catalog.get(slug)).filter(Boolean);
syncInstructions();
log(`catalog: ${catalog.size} tools from ${BASE}; ${curated.length} first-class, rest via catalog.search/catalog.call`);
// A key is reported configured only once it parses: a key that does not
// parse is named (never printed) so the operator sees it before the first
// paid call fails on it.
{
  const parsed = [], broken = [];
  if (AGENT_KEY) {
    try { const { privateKeyToAccount } = await import("viem/accounts"); evmAccount(privateKeyToAccount); parsed.push(STORED_KEY ? "EVM (stored key)" : "EVM"); } catch { broken.push(AGENT_KEY_NAME); }
  }
  if (SOLANA_AGENT_KEY) {
    try { await solanaSigner(); parsed.push("Solana"); } catch { broken.push("SOLANA_AGENT_KEY"); }
  }
  const caps = `max/call ${MAX_PER_CALL === Infinity ? "unlimited" : `$${MAX_PER_CALL}`}, session budget ${BUDGET === Infinity ? "unlimited" : `$${BUDGET}`}${Number.isFinite(LEDGER.dayCap) ? `, $${LEDGER.dayCap}/day` : ""}${Number.isFinite(LEDGER.monthCap) ? `, $${LEDGER.monthCap}/month` : ""}`;
  if (broken.length) log(`payment: ${broken.join(" and ")} ${broken.length > 1 ? "are set but do" : "is set but does"} not parse as a key (the value is never printed); paid calls that need ${broken.length > 1 ? "them fail until they are" : "it fail until it is"} fixed`);
  log(parsed.length
    ? `payment: USDC via x402 (${parsed.join(" + ")} wallet configured; ${caps})`
    : HAS_WALLET
      ? "payment: no usable wallet key"
      : HAS_CREDITS
        ? `payment: credits key configured (${caps})`
        : "payment: proof-of-work on eligible tools (no AGENT_KEY / SOLANA_AGENT_KEY)");
}

await server.connect(new StdioServerTransport());
