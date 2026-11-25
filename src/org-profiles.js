// ONE list of the profiles that are ours, for every Organization JSON-LD
// `sameAs` (the site entity on every page, src/site-org.js, and the company on
// /company). A profile is listed only once it exists and is published by us:
// the repository, the X account, our npm and PyPI packages, and our entry in
// the MCP Registry. A third-party directory page about us is never one.
// scripts/test-org-same-as.js fails when a module writes its own list.
import { REPO_URL, REPO_NAMESPACE } from "./repo-link.js";

export const X_PROFILE_URL = "https://x.com/Agent402Tools";

/** The MCP Registry name, the same one mcp/server.json publishes. */
export const MCP_REGISTRY_NAME = `${REPO_NAMESPACE}/agent402`;

/** Our MCP Registry entry, latest version. */
export const MCP_REGISTRY_ENTRY_URL = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(MCP_REGISTRY_NAME)}/versions/latest`;

export const ORG_SAME_AS = Object.freeze([
  REPO_URL,
  X_PROFILE_URL,
  "https://www.npmjs.com/package/agent402-mcp",
  "https://www.npmjs.com/package/agent402-client",
  "https://www.npmjs.com/package/agent402-tollbooth",
  "https://pypi.org/project/agent402-structured-tools/",
  MCP_REGISTRY_ENTRY_URL,
]);
