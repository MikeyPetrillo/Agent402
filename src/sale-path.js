// Which path a paid call arrived on, for the sales ledger's operator split.
//
//   "mcp"            the hosted connector's paid loopback replay (/mcp ->
//                    src/mcp-mpp.js), proved by the marker on a local socket
//   "<pkg>/<version>" one of our client or adapter packages, read from the
//                    User-Agent's first product token when it names a package
//                    on the list below
//   "http"           everything else
//
// Only the product token is ever stored (at most 40 characters of letters,
// digits, dots, slashes and hyphens), never the full User-Agent, never an
// address. Rows recorded before the column existed read "unknown".
import { isMcpLoopback } from "./unpaid-quote-budget.js";

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

/** The path value recorded for this request: "mcp", a package token, or "http". */
export function salePathOf(req) {
  try {
    if (isMcpLoopback(req)) return "mcp";
    return clientTokenOf(req?.headers?.["user-agent"]) || "http";
  } catch { return "http"; }
}

/** A stored value (or NULL) as its group: "mcp", "http", "unknown", or the package name. */
export function salePathGroup(via) {
  if (via == null || via === "") return "unknown";
  const s = String(via);
  if (s === "mcp" || s === "http" || s === "unknown") return s;
  const name = s.split("/")[0].toLowerCase();
  return PACKAGE_SET.has(name) ? name : "unknown";
}

/** A value safe to store: one of the fixed words or a well-formed package token, else null. */
export function cleanSalePath(via) {
  if (via == null) return null;
  const s = String(via);
  if (s === "mcp" || s === "http") return s;
  return clientTokenOf(s);
}
