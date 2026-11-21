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
]);
