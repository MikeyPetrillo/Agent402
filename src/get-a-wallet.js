// The "get a wallet" step beside every AGENT_KEY placeholder on a page: where a
// first wallet is funded (/start#fund) and the command that makes one on the
// reader's own computer (`agent402-mcp wallet new`, mcp/wallet-new.js), which
// stores the key and prints the address and the config, never the key.
// scripts/test-get-a-wallet.js holds every served page that shows a
// placeholder to it.
import { AGENT402_MCP_VERSION } from "./mcp-flagship.js";
import { esc } from "./ledger-chrome.js";

export const GET_A_WALLET_HREF = "/start#fund";
export const WALLET_NEW_COMMAND = `npx -y agent402-mcp@${AGENT402_MCP_VERSION} wallet new`;

/** The step as one HTML sentence. `link(href, label)` and `code(text)` are the
 *  page's own helpers (each returns HTML; `code` escapes its text). */
export function getWalletHtml({ link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`, code = (t) => `<code>${esc(t)}</code>` } = {}) {
  return `No wallet yet? ${link(GET_A_WALLET_HREF, "Fund a first one")} with USDC on Base, no ETH needed, or run ${code(WALLET_NEW_COMMAND)} to make one on this computer: it stores the key and prints the address and the config, never the key.`;
}

/** The step as one short line, for a page that shows it under every sample
 *  (the tool pages): the same link and the same command. */
export function getWalletShortHtml({ link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`, code = (t) => `<code>${esc(t)}</code>` } = {}) {
  return `${link(GET_A_WALLET_HREF, "Get a wallet")} or run ${code(WALLET_NEW_COMMAND)}.`;
}

/** The same step in markdown, for a page written as markdown. */
export function getWalletMarkdown(baseUrl = "") {
  return `No wallet yet? [Fund a first one](${baseUrl}${GET_A_WALLET_HREF}) with USDC on Base, no ETH needed, or run \`${WALLET_NEW_COMMAND}\` to make one on this computer: it stores the key and prints the address and the config, never the key.`;
}
