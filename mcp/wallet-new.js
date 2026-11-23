// `npx agent402-mcp wallet new`: makes a fresh wallet key on this computer,
// stores it where `npx agent402-mcp setup` would (the OS credential store,
// ./key-store.js, else a 0600 file with a warning), and prints the wallet's
// address, how to fund it and the client config. The key is never printed,
// logged or passed on a command line. A key already stored is never replaced:
// the wallet it opens may hold funds.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configDir } from "./config-dir.js";
import { evmKeyOrNull } from "./wallet-key.js";
import { keyStoreKind, storeKey, readStoredKey, removeKeyFile, runCommand } from "./key-store.js";
import { configSnippets } from "./setup.js";

export const WALLET_USAGE = "Usage: npx agent402-mcp wallet new   (makes a wallet key on this computer and stores it for the MCP server)";

/**
 * Run `wallet new`. Returns the process exit code.
 * @param {{output?: NodeJS.WriteStream, env?: object, run?: Function, platform?: string, generate?: () => string}} o
 */
export async function runWalletNew({ output = process.stdout, env = process.env, run = runCommand, platform = process.platform, generate = generatePrivateKey } = {}) {
  const say = (s = "") => output.write(`${s}\n`);
  const dir = configDir({ env, platform });
  let kind = keyStoreKind({ env, platform, run });
  if (kind === "off") { say("AGENT402_KEY_STORE=off turns every key store off, so there is nowhere to keep a new key. Unset it and run this again."); return 1; }
  const existing = evmKeyOrNull(readStoredKey({ kind, dir, run }) || "");
  if (existing) {
    say(`A wallet key is already stored (wallet ${privateKeyToAccount(existing).address}). Nothing was changed: a new key would replace it, and the funds in that wallet would be out of reach.`);
    say("The MCP server uses that wallet whenever AGENT_KEY is not set. To use a different one, run `npx agent402-mcp setup` and paste its key.");
    return 1;
  }
  const key = generate();
  const address = privateKeyToAccount(key).address;
  let saved = storeKey(key, { kind, dir, run });
  if (!saved.stored && kind !== "file") {
    say(`Note: ${saved.reason}; storing it in a file instead.`);
    kind = "file";
    saved = storeKey(key, { kind, dir, run });
  } else if (saved.stored && kind !== "file") removeKeyFile(dir);
  if (!saved.stored) { say(`Could not store the new key: ${saved.reason}. Nothing was made.`); return 1; }
  say("New Agent402 wallet made on this computer.");
  say("");
  say(`Wallet address: ${address}`);
  say(`The key is stored in ${saved.where} and is never shown. Keep only a few dollars in this wallet.`);
  if (saved.warning) say(`Warning: ${saved.warning}.`);
  say("");
  say("Fund it with USDC on Base, no ETH needed: send a few dollars of USDC on the Base network to the address above. A Base payment is an authorization you sign, and the facilitator pays the network fee.");
  const s = configSnippets();
  say("");
  say("Claude Code, run:");
  say(`  ${s.claudeCode}`);
  say("");
  say("Claude Desktop (claude_desktop_config.json) or Cursor (~/.cursor/mcp.json), add:");
  say(s.claudeDesktop.split("\n").map((l) => `  ${l}`).join("\n"));
  say("");
  say("Restart the client. The server reads the stored key whenever AGENT_KEY is not set. Optional caps that hold across restarts: AGENT402_MAX_USD_PER_DAY and AGENT402_MAX_USD_PER_MONTH.");
  return 0;
}
