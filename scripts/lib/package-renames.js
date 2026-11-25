// The published packages that took a new name, and the forwarding release each
// earlier name gets. One list: the forwarding packages under renamed/, the
// publish job, scripts/package-renames.js (the owner's commands around a
// release) and scripts/test-package-renames.js all read it.
//
//   old         the earlier published name (npm, or PyPI for registry "pypi")
//   name        the current name
//   dir         where the current package's source lives
//   version     the current package's first version under its new name
//   shimVersion the earlier name's last release: it forwards to the new name
export const PACKAGE_RENAMES = Object.freeze([
  { registry: "npm", old: "agent402-openai-tools", name: "agent402-function-calling", dir: "adapters/openai-tools", version: "0.3.0", shimVersion: "0.2.3" },
  { registry: "npm", old: "agent402-anthropic-tools", name: "agent402-messages-tools", dir: "adapters/anthropic-tools", version: "0.3.0", shimVersion: "0.2.3" },
  { registry: "npm", old: "agent402-openai-agents", name: "agent402-runner-tools", dir: "adapters/openai-agents", version: "0.2.0", shimVersion: "0.1.15" },
  { registry: "npm", old: "agent402-google-adk", name: "agent402-dev-kit-tools", dir: "adapters/google-adk", version: "0.2.0", shimVersion: "0.1.15" },
  { registry: "npm", old: "agent402-agentkit", name: "agent402-action-provider", dir: "adapters/agentkit", version: "0.3.0", shimVersion: "0.2.2" },
  { registry: "npm", old: "agent402-langchain", name: "agent402-structured-tools", dir: "adapters/langchain", version: "0.3.0", shimVersion: "0.2.14" },
  { registry: "npm", old: "agent402-llamaindex", name: "agent402-function-tools", dir: "adapters/llamaindex", version: "0.3.0", shimVersion: "0.2.3" },
  { registry: "npm", old: "agent402-ai-sdk", name: "agent402-stream-tools", dir: "adapters/ai-sdk", version: "0.3.0", shimVersion: "0.2.15" },
  { registry: "npm", old: "elizaos-plugin-agent402", name: "agent402-actions-plugin", dir: "adapters/eliza", version: "0.4.0", shimVersion: "0.3.3" },
  { registry: "npm", old: "agent402-strands", name: "agent402-agent-loop-tools", dir: "adapters/strands", version: "0.3.0", shimVersion: "0.2.3" },
  { registry: "npm", old: "agent402-openclaw", name: "agent402-model-provider", dir: "openclaw", version: "0.7.0", shimVersion: "0.6.3" },
  { registry: "pypi", old: "agent402-langchain", name: "agent402-structured-tools", dir: "adapters/langchain-py", version: "0.2.0", shimVersion: "0.1.7" },
]);

/** The directory that holds the forwarding release of an earlier name. */
export const shimDir = (r) => `renamed/${r.old}${r.registry === "pypi" ? "-py" : ""}`;

/** The caret range a forwarding release depends on: the new name's minor line. */
export const forwardRange = (r) => `^${r.version}`;

/** The one-time notice a forwarding release prints. */
export const renameNotice = (r) => r.registry === "pypi"
  ? `${r.old} is renamed to ${r.name} (same API): pip install ${r.name}, then import ${r.name.replace(/-/g, "_")}. This name gets no further releases.`
  : `${r.old} is renamed to ${r.name} (same API): npm i ${r.name}, then import from "${r.name}". This name gets no further releases.`;
