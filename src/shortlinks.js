// Dev shortlinks: agent402.sh/<word> (a path-preserving redirect domain) and
// agent402.tools/<word> land on the page that answers "how do I use this from
// X". Every target is a real, indexed page; the shortlink itself is a 302 so
// nothing here competes with the canonical URL. /install is the one exception:
// a POSIX script for `curl -fsSL agent402.sh/install | sh` that wires the MCP
// connector into whichever hosts are on the machine and prints the rest.
export const SHORTLINKS = Object.freeze({
  "/claude": "/guides/agent-hosts#claude-code",
  "/claude-code": "/guides/agent-hosts#claude-code",
  "/cursor": "/guides/agent-hosts#cursor",
  "/vscode": "/guides/agent-hosts#vs-code",
  "/copilot": "/guides/agent-hosts#vs-code",
  "/windsurf": "/guides/agent-hosts#windsurf",
  "/cline": "/guides/agent-hosts#cline",
  "/roo": "/guides/agent-hosts#roo-code",
  "/codex": "/guides/agent-hosts#openai-codex-cli",
  "/gemini": "/guides/agent-hosts#gemini-cli",
  "/continue": "/guides/agent-hosts#continue",
  "/eliza": "/guides/agent-hosts#elizaos",
  "/elizaos": "/guides/agent-hosts#elizaos",
  "/openai": "/guides/agent-hosts#any-openai-sdk",
  "/anthropic": "/guides/agent-hosts#any-anthropic-sdk-messages-wire",
  "/agentcore": "/guides/agent-hosts#amazon-bedrock-agentcore",
  "/bedrock": "/guides/agent-hosts#amazon-bedrock-agentcore",
  "/openclaw": "/guides/openclaw-model-provider",
  "/agentkit": "/docs/adapters",
  "/langchain": "/docs/adapters/langchain",
  "/llamaindex": "/docs/adapters/llamaindex",
  "/adapters": "/docs/adapters",
  "/hosts": "/guides/agent-hosts",
  "/key": "/credits",
  "/api": "/docs",
});

/** The install script. Idempotent, prints what it does, never needs sudo. */
export function installScript(baseUrl) {
  const b = String(baseUrl || "https://agent402.tools").replace(/\/$/, "");
  return `#!/bin/sh
# Agent402 install: wires the hosted MCP connector into the agent hosts on
# this machine and prints the rest. Re-runnable. No sudo. Source:
# ${b}/install  (docs: ${b}/guides/agent-hosts)
set -eu
MCP_URL="${b}/mcp"
say() { printf '%s\\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
did=0
say "Agent402: 500+ paid tools, metered models and reports for agents. Free tier via proof-of-work, paid via x402/MPP or a prepaid credits key."
say ""
if have claude; then
  say "-> Claude Code found: adding the Agent402 MCP connector (claude mcp add --transport http agent402 $MCP_URL)"
  if claude mcp add --transport http agent402 "$MCP_URL" >/dev/null 2>&1; then say "   done."; did=1; else say "   already added or refused; run it yourself to see why."; fi
  if [ -n "\${AGENT402_CREDITS_KEY:-}" ]; then
    say "-> AGENT402_CREDITS_KEY is set. To use Agent402 as Claude Code's model gateway:"
    say "   export ANTHROPIC_BASE_URL=${b}/v1/metered; export ANTHROPIC_AUTH_TOKEN=\\$AGENT402_CREDITS_KEY"
  fi
fi
if have openclaw; then
  say "-> OpenClaw found: run  npx agent402-openclaw setup   (mints a wallet or takes a credits key, writes the provider)"
fi
if have cursor || [ -d "$HOME/.cursor" ]; then
  say "-> Cursor: add to ~/.cursor/mcp.json ->  {\\"mcpServers\\":{\\"agent402\\":{\\"url\\":\\"$MCP_URL\\"}}}"
fi
if [ "$did" = 0 ]; then
  say "No host wired automatically. Copy-paste blocks for Claude Code, Cursor, Continue, ElizaOS, AgentCore and any OpenAI/Anthropic SDK:"
  say "   ${b}/guides/agent-hosts"
fi
say ""
say "Models: OpenAI-compatible base URL ${b}/v1/metered with a credits key (${b}/credits) or a funded wallet."
say "Try one free call:  curl -s '${b}/api/find?q=web+search'"
`;
}

export function mountShortlinks(app, baseUrl) {
  for (const [path, target] of Object.entries(SHORTLINKS)) app.get(path, (_req, res) => res.redirect(302, target));
  app.get("/install", (_req, res) => res.set("Cache-Control", "public, max-age=300").type("text/x-shellscript; charset=utf-8").send(installScript(baseUrl)));
  app.get("/install.sh", (_req, res) => res.redirect(302, "/install"));
}
