// What the hosted MCP connector (/mcp) takes as payment in the call on THIS
// boot, as copy. One source for every page and text surface that describes
// paying on the connector (/llms.txt, /agents.md, /how-to-pay, /quickstart,
// /learn/mcp-payments, /integrations/mcp, the guides), so each names only the
// wires the connector mounts:
//   x402  every boot with a paywall. src/server.js mounts the x402 loopback
//         unless FREE_MODE, which has no paywall and so nothing to pay.
//   MPP   while the MPP gates are on (the same MPP_SECRET_KEY switch the
//         connector's MPP loopback reads), and never in FREE_MODE: with no
//         paywall the connector asks for nothing, whatever key is set.
// The x402 wire is blocking only: a tool whose run can outlast the
// connector's blocking wait (an async profile, src/slow-sync-window.js) is
// refused before the payment is presented, so the long text scopes the claim
// (such a tool is paid in the call over MPP, as an MCP task).
// The connector's own answers (initialize instructions, server.describe,
// payment.info, a paid tool's first ask, the listed descriptions) read the
// same account: src/server.js passes connectorWires() to the mount as
// `payWires` (src/mcp-http.js); scripts/test-connector-pay-copy.js holds the
// two in agreement on the paid boots and the FREE_MODE boots.
import { mppShimEnabled } from "./mpp-shim.js";

export const X402_MCP_PAYMENT_KEY = '_meta["x402/payment"]';
export const X402_MCP_RECEIPT_KEY = '_meta["x402/payment-response"]';
export const MPP_MCP_ASK_KEY = '_meta["org.paymentauth/payment-required"]';
export const MPP_MCP_CREDENTIAL_KEY = '_meta["org.paymentauth/credential"]';

/** The variables this account reads, as `env` holds them (undefined = unset).
 *  A suite that renders a page module in-process beside a booted server sets
 *  these to the server's values before it imports the module, so the copy it
 *  expects is the copy that boot writes. */
export const CONNECTOR_ENV_KEYS = Object.freeze(["FREE_MODE", "MPP_SECRET_KEY"]);
export function connectorEnvOf(env = process.env) {
  return Object.fromEntries(CONNECTOR_ENV_KEYS.map((k) => [k, env[k]]));
}

/** Whether this boot's connector takes an x402 payment in the call. */
export function connectorX402Enabled(env = process.env) {
  return env.FREE_MODE !== "true";
}

/** Whether this boot's connector takes an MPP credential in the call: the
 *  MPP gates on, and a paywall to ask from. */
export function connectorMppEnabled(env = process.env) {
  return env.FREE_MODE !== "true" && (env === process.env ? mppShimEnabled() : Boolean(env.MPP_SECRET_KEY));
}

/** The wires the connector takes in the call: { x402, mpp, names, phrase }.
 *  `phrase` is "x402 or MPP", "x402", "MPP" or "". */
export function connectorWires({ x402 = connectorX402Enabled(), mpp = connectorMppEnabled() } = {}) {
  const names = [x402 && "x402", mpp && "MPP"].filter(Boolean);
  return { x402: Boolean(x402), mpp: Boolean(mpp), names, phrase: names.join(" or ") };
}

/** One short line for a surface with a byte budget (/llms.txt): the wires,
 *  and where the full account is. */
export function connectorPayShort(opts) {
  const w = connectorWires(opts);
  return w.names.length
    ? `Wallet-only tools are payable in the call over ${w.phrase} (how: /agents.md)`
    : "This instance runs in free mode: its connector takes no payment";
}

/** How a wallet-only tool is paid on the connector, in full. `code` wraps a
 *  wire key (backticks in markdown, <code> in HTML, nothing in plain text). */
export function connectorPayText({ code = (s) => s, ...opts } = {}) {
  const w = connectorWires(opts);
  // No wire: a FREE_MODE boot, the one boot that mounts no x402 loopback.
  if (!w.names.length) {
    return "This instance runs in free mode, with no paywall: its connector serves the proof-of-work tools and answers a wallet-only tool with setup text, and every route is open over HTTP.";
  }
  const ways = [];
  if (w.x402) ways.push(`over x402 (the first ask is a tool result whose first text block is the x402 PaymentRequired as JSON; an x402 MCP client signs one of its accepts and calls again with the payment in ${code(X402_MCP_PAYMENT_KEY)}, and the settle receipt returns in ${code(X402_MCP_RECEIPT_KEY)})`);
  if (w.mpp) ways.push(`over MPP (the challenges ride in ${code(MPP_MCP_ASK_KEY)}; an mppx MCP client pays and calls again with the credential in ${code(MPP_MCP_CREDENTIAL_KEY)})`);
  return `A wallet-only tool is payable in the call on the hosted connector, ${ways.join(", or ")}, at the price the HTTP route quotes.${w.x402 ? " A free tool at its rate limit answers with its x402 offer too, so a call that pays is served past the limit." : ""}${connectorLongCallText({ code, ...opts })}`;
}

/** The scope of the in-call claim: the x402 wire on the connector is blocking
 *  only, so a long-running tool (the report products and the other routes
 *  with an async profile) is not paid there over x402. "" when x402 is off
 *  (MPP alone serves a long call as a task; no wire, nothing to scope). */
export function connectorLongCallText({ code = (s) => s, ...opts } = {}) {
  const w = connectorWires(opts);
  if (!w.x402) return "";
  return ` A long-running tool (a report product, or any run that can outlast the connector's blocking wait) is the exception over x402: ${w.mpp ? "pay it in the call over MPP, where the run is handed back as an MCP task, or call" : "call"} its HTTP route with ${code("Prefer: respond-async")}.`;
}
