// /aws/openapi.json: the OpenAPI 3.1 document of the AWS Marketplace listing.
//
// Built at request time from the gate's served set (src/aws-marketplace-gate.js)
// and each tool's catalog definition: one operation per served tool at
// /<slug> under the one server BASE_URL + /aws, with the tool's input schema,
// its published example, its list price and the x402 `aws:base` payment it
// takes. No other path and no other server: the document describes the
// listing and nothing past it. Descriptions are the AWS-facing ones
// (src/aws-listing.js awsDescriptionOf), followed by the group's notice.
import { AWS_JWKS_PATH, AWS_NETWORK, AWS_PREFIX } from "./aws-marketplace-gate.js";
import { awsGroupOf } from "./aws-listing.js";
import { awsPriceLabel, AWS_SUPPORT_EMAIL } from "./aws-start-page.js";

const objectSchema = (discovery) => {
  const props = discovery?.inputSchema?.properties && typeof discovery.inputSchema.properties === "object" ? discovery.inputSchema.properties : {};
  const required = Array.isArray(discovery?.inputSchema?.required) ? discovery.inputSchema.required.filter((k) => Object.hasOwn(props, k)) : [];
  return { type: "object", properties: props, ...(required.length ? { required } : {}) };
};

/** The document. `defs`: the served set (slug -> definition, listed order). */
export function awsOpenapi({ baseUrl, defs, config, describe = (d) => d?.description }) {
  const origin = (() => { try { return new URL(String(baseUrl)).origin; } catch { return String(baseUrl || "").replace(/\/+$/, ""); } })();
  const paths = {};
  for (const [slug, def] of defs || []) {
    const method = String(def.route || "").split(" ")[0] === "GET" ? "get" : "post";
    const price = awsPriceLabel(def);
    const amount = price.replace(/^\$/, "");
    const group = awsGroupOf(slug);
    const schema = objectSchema(def.discovery);
    const example = def.discovery?.input && typeof def.discovery.input === "object" && !Array.isArray(def.discovery.input) ? def.discovery.input : {};
    const op = {
      operationId: slug.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase()),
      summary: `${def.name || slug} (${price} per call)`,
      description: `${describe(def)}\n\n${group.notice}\n\nPrice: ${price} per call, paid with x402 \`exact\` on \`${AWS_NETWORK}\` in US dollars through Amazon Bedrock AgentCore payments with the AWS Billing connector, billed on your AWS invoice.`,
      tags: [group.title],
      responses: {
        200: { description: "The tool's answer.", content: { "application/json": { schema: { type: "object" } } } },
        400: { description: "The input was refused before the run; the payment was not used." },
        402: { description: `Payment Required: one x402 offer, scheme exact on ${AWS_NETWORK}, priced in iso4217:USD, with a quote signed by the key at ${origin}${AWS_JWKS_PATH}, in the PAYMENT-REQUIRED header.` },
        409: { description: "This payment was already used." },
        429: { description: "Too many requests from this client in the last minute; see Retry-After." },
      },
      "x-price": price,
      "x-payment-info": {
        protocols: [{ x402: {} }],
        price: { mode: "fixed", currency: "USD", amount },
        scheme: "exact",
        network: AWS_NETWORK,
        asset: "iso4217:USD",
      },
    };
    if (method === "get") {
      op.parameters = Object.entries(schema.properties).map(([name, s]) => ({
        name, in: "query", required: (schema.required || []).includes(name),
        schema: s && typeof s === "object" ? s : {},
        ...(Object.hasOwn(example, name) ? { example: example[name] } : {}),
      }));
    } else {
      op.requestBody = { required: true, content: { "application/json": { schema, example } } };
    }
    paths[`/${slug}`] = { [method]: op };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent402 on AWS Marketplace",
      version: "1.0.0",
      description: `Tools sold through AWS Marketplace. Each call is paid per request with x402 \`exact\` on \`${AWS_NETWORK}\`, in US dollars on your AWS bill. A payment buys one answer; a call that does not complete gives the payment back for up to ${Number(config?.retryMax ?? 0)} more attempt(s) while it is valid.`,
      contact: { email: AWS_SUPPORT_EMAIL },
    },
    servers: [{ url: `${origin}${AWS_PREFIX}` }],
    paths,
  };
}
