// Which path a paid call arrived on, for the sales ledger's operator split.
//
//   "x402-mcp"       the hosted connector's x402 twin of a flagship
//                    (src/mcp-x402-routes.js), set only by its internal gate
//   "mcp"            the hosted connector's paid loopback replay (/mcp ->
//                    src/mcp-mpp.js), proved by the marker on a local socket
//   "<pkg>/<version>" one of our client or adapter packages, read from the
//                    User-Agent's first product token when it names a package
//                    on the list below
//   "bazaar"         a User-Agent the traffic classifier names as the Bazaar
//                    (KNOWN_INDEXERS in src/traffic-classifier.js)
//   "http"           everything else
//
// Only the product token is ever stored (at most 40 characters of letters,
// digits, dots, slashes and hyphens), never the full User-Agent, never an
// address. Rows recorded before the column existed read "unknown".
import { isMcpLoopback } from "./unpaid-quote-budget.js";
import { loopbackRunKeyOf } from "./mcp-loopback.js";
import { isX402McpRequest, MCP_X402_SALE_PATH } from "./mcp-x402-routes.js";
import { indexerFor } from "./traffic-classifier.js";

/** The stored path of a call whose User-Agent names the Bazaar. */
export const BAZAAR_SALE_PATH = "bazaar";
const isBazaarUa = (ua) => indexerFor(ua)?.name === "coinbase-bazaar";

/** Our published packages whose User-Agent product token names them. */
export const CLIENT_PACKAGES = Object.freeze([
  "agent402-client",
  "agent402-mcp",
  "agent402-openclaw",
  "agent402-agentkit",
  "agent402-ai-sdk",
  "agent402-anthropic-tools",
  "elizaos-plugin-agent402",
  "agent402-google-adk",
  "agent402-langchain",
  "agent402-langchain-py",
  "agent402-llamaindex",
  "agent402-openai-agents",
  "agent402-openai-tools",
  "agent402-strands",
  // The same packages under their current names (the names above are their
  // earlier ones; installs that still pin them keep sending those tokens).
  "agent402-model-provider",
  "agent402-action-provider",
  "agent402-stream-tools",
  "agent402-tool-use",
  "agent402-actions-plugin",
  "agent402-dev-kit-tools",
  "agent402-structured-tools",
  "agent402-structured-tools-py",
  "agent402-function-tools",
  "agent402-runner-tools",
  "agent402-function-calling",
  "agent402-agent-loop-tools",
]);
const PACKAGE_SET = new Set(CLIENT_PACKAGES);
const TOKEN_RE = /^[A-Za-z0-9./-]{1,40}$/;

/** The stored product token for a User-Agent when it names one of our packages, else null. */
export function clientTokenOf(userAgent) {
  const first = String(userAgent || "").trim().split(/\s+/)[0] || "";
  const token = first.slice(0, 40);
  if (!TOKEN_RE.test(token)) return null;
  const name = token.split("/")[0].toLowerCase();
  return PACKAGE_SET.has(name) ? token : null;
}

/** The path value recorded for this request: "x402-mcp", "mcp", a package token, "bazaar", or "http". */
export function salePathOf(req) {
  try {
    if (isX402McpRequest(req)) return MCP_X402_SALE_PATH;
    if (isMcpLoopback(req)) return "mcp";
    const ua = req?.headers?.["user-agent"];
    return clientTokenOf(ua) || (isBazaarUa(ua) ? BAZAAR_SALE_PATH : "http");
  } catch { return "http"; }
}

/** The run key the sales ledger books on this request's sale: the task run's
 *  key on the connector's genuine loopback replay, or the job run's key on an
 *  async job's genuine replay (src/async-jobs.js reads it only beside its
 *  token), else null. Never caller text: each is read only with its proof. */
export function saleRunKeyOf(req) {
  try {
    const mcp = loopbackRunKeyOf(req);
    if (mcp) return mcp;
    return req?.asyncJobLoopback === true && typeof req.asyncRunKey === "string" && RUN_RE.test(req.asyncRunKey) ? req.asyncRunKey : null;
  } catch { return null; }
}
const RUN_RE = /^[0-9a-f]{32}$/;

/** A stored value (or NULL) as its group: "x402-mcp", "mcp", "bazaar", "http", "unknown", or the package name. */
export function salePathGroup(via) {
  if (via == null || via === "") return "unknown";
  const s = String(via);
  if (s === "mcp" || s === MCP_X402_SALE_PATH || s === BAZAAR_SALE_PATH || s === "http" || s === "unknown") return s;
  const name = s.split("/")[0].toLowerCase();
  return PACKAGE_SET.has(name) ? name : "unknown";
}

/** A value safe to store: one of the fixed words or a well-formed package token, else null. */
export function cleanSalePath(via) {
  if (via == null) return null;
  const s = String(via);
  if (s === "mcp" || s === MCP_X402_SALE_PATH || s === BAZAAR_SALE_PATH || s === "http") return s;
  return clientTokenOf(s);
}
