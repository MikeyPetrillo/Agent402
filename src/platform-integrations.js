// Platform pages under /integrations/<slug> that are not package pages
// (src/integration-pages.js lists those). One list, no imports, feeds the
// integrations index, the sitemap and /llms.txt, so a page is linked from all
// three or none.
export const PLATFORM_INTEGRATIONS = Object.freeze([
  Object.freeze({
    slug: "agentcore",
    name: "Amazon Bedrock AgentCore",
    line: "Catalog tools through an AgentCore Gateway target, paid through AgentCore Payments.",
    surface: "openapi.json · /mcp",
    llms: "set up an AgentCore Gateway target from openapi.json or the hosted MCP connector, and pay per call through AgentCore Payments over x402",
  }),
  Object.freeze({
    slug: "claude-managed-agents",
    name: "Claude Managed Agents",
    line: "The hosted MCP connector on a managed agent: free tools in the session, paid calls through a host-side custom tool.",
    surface: "/mcp",
    llms: "attach the hosted MCP connector to a Claude Managed Agents agent definition, run the free tools in a session, and pay for the rest through a host-side custom tool that pays from your wallet",
  }),
]);
