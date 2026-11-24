// `npx agent402-mcp setup`: asks for the wallet key once (the input is not
// shown), stores it in the OS credential store (./key-store.js), and prints
// the client config that needs no AGENT_KEY variable. The key is never
// printed, logged or passed on a command line.
import { readFileSync } from "node:fs";
import { configDir } from "./config-dir.js";
import { DAY_CAP_HOW } from "./spend-ledger.js";
import { evmKeyOrNull, EVM_KEY_FORM } from "./wallet-key.js";
import { keyStoreKind, storeKey, removeKeyFile, runCommand } from "./key-store.js";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const MAX_TRIES = 3;
const MAX_INPUT_CHARS = 512;

/** One line from `input`. On a terminal the typed characters are not echoed. */
export function readHiddenLine(input, output, prompt) {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = "";
    const tty = !!input.isTTY && typeof input.setRawMode === "function";
    const done = (err, v) => {
      input.removeListener("data", onData); input.removeListener("end", onEnd); input.removeListener("error", onErr);
      if (tty) input.setRawMode(false);
      input.pause();
      if (tty) output.write("\n");
      if (err) reject(err); else resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") return done(Object.assign(new Error("setup canceled"), { canceled: true }));
        if (ch === "\r" || ch === "\n") return done(null, buf);
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (buf.length < MAX_INPUT_CHARS) buf += ch;
      }
    };
    const onEnd = () => done(null, buf.length ? buf : null);
    const onErr = (e) => done(e);
    if (tty) input.setRawMode(true);
    input.setEncoding?.("utf8");
    input.on("data", onData); input.once("end", onEnd); input.once("error", onErr);
    input.resume();
  });
}

/** The config snippets for each client, pinned to this version. */
// The config carries no spending cap: none is written by default
// (DAY_CAP_HOW, printed after it, says how to add one).
export function configSnippets(version = VERSION) {
  const json = JSON.stringify({ mcpServers: { agent402: { command: "npx", args: ["-y", `agent402-mcp@${version}`] } } }, null, 2);
  return {
    claudeCode: `claude mcp add agent402 -s user -- npx -y agent402-mcp@${version}`,
    claudeDesktop: json,
    cursor: json,
  };
}

/** The wallet address of a key (public; safe to print). */
async function addressOf(key) {
  try { const { privateKeyToAccount } = await import("viem/accounts"); return privateKeyToAccount(key).address; } catch { return null; }
}

/**
 * Run the setup. Returns the process exit code.
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, env?: object, run?: Function, platform?: string}} o
 */
export async function runSetup({ input = process.stdin, output = process.stdout, env = process.env, run = runCommand, platform = process.platform } = {}) {
  const say = (s = "") => output.write(`${s}\n`);
  const dir = configDir({ env, platform });
  let kind = keyStoreKind({ env, platform, run });
  if (kind === "off") { say("AGENT402_KEY_STORE=off turns every key store off, so setup has nowhere to keep the key. Unset it and run setup again."); return 1; }
  say("Agent402 setup: store your wallet key once, so Claude, Cursor or any MCP client can pay per call with no AGENT_KEY in its config.");
  say("The key stays on this computer and is never printed.");
  say("");
  let key = null;
  for (let i = 0; i < MAX_TRIES && !key; i++) {
    let raw;
    try { raw = await readHiddenLine(input, output, "Paste the private key of the wallet that holds your USDC, then press Enter (the input is hidden): "); }
    catch (e) { say(e?.canceled ? "Setup canceled; nothing was stored." : "Could not read the key; nothing was stored."); return 1; }
    if (raw == null) { say("No key was entered; nothing was stored."); return 1; }
    key = evmKeyOrNull(raw);
    if (!key) say(`That is not ${EVM_KEY_FORM}. Nothing was stored.${input.isTTY && i < MAX_TRIES - 1 ? " Try again." : ""}`);
    if (!key && !input.isTTY) return 1;
  }
  if (!key) return 1;
  let saved = storeKey(key, { kind, dir, run });
  if (!saved.stored && kind !== "file") {
    say(`Note: ${saved.reason}; storing it in a file instead.`);
    kind = "file";
    saved = storeKey(key, { kind, dir, run });
  } else if (saved.stored && kind !== "file") removeKeyFile(dir);
  if (!saved.stored) { say(`Could not store the key: ${saved.reason}.`); return 1; }
  const address = await addressOf(key);
  say("");
  say(`Stored in ${saved.where}.${address ? ` Wallet ${address}.` : ""}`);
  if (saved.warning) say(`Warning: ${saved.warning}.`);
  say("Fund that wallet with USDC on Base. A Base payment needs no ETH: you sign an authorization and the facilitator pays the network fee.");
  const s = configSnippets();
  say("");
  say("Claude Code, run:");
  say(`  ${s.claudeCode}`);
  say("");
  say("Claude Desktop (claude_desktop_config.json) or Cursor (~/.cursor/mcp.json), add:");
  say(s.claudeDesktop.split("\n").map((l) => `  ${l}`).join("\n"));
  say("");
  say("Restart the client. The server reads the stored key whenever AGENT_KEY is not set. Each call is capped at $5 unless AGENT402_MAX_PER_CALL says otherwise.");
  say(DAY_CAP_HOW);
  return 0;
}
