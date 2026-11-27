// The MCP Registry's HTTP proof of a domain namespace.
//
// The registry grants a reverse-DNS server name (the domain's own namespace)
// to whoever holds the private key whose public half the domain serves at
// MCP_REGISTRY_AUTH_PATH: one line, "v=MCPv1; k=<algorithm>; p=<public key>".
// The registry reads it over https with no redirect followed and takes at
// most 4096 bytes.
//
// MCP_REGISTRY_AUTH_PROOF holds that line. It is a public key, not a secret.
// Key present = route on; unset = the ordinary 404. A value that is not a
// proof record leaves the route off and is reported at boot by name, never
// echoed: a typo must not be served from the domain as its proof.
export const MCP_REGISTRY_AUTH_PATH = "/.well-known/mcp-registry-auth";
export const MCP_REGISTRY_AUTH_MAX_BYTES = 4096;

// ed25519: 32 bytes (43 base64 characters and one pad). ecdsap384: a
// compressed point, 49 bytes (66 characters and two pads).
const RECORD = /^v=MCPv1; k=(?:ed25519; p=[A-Za-z0-9+/]{43}=|ecdsap384; p=[A-Za-z0-9+/]{66}==)$/;

/** { proof, error }: the record to serve, or why the setting is not served.
 *  Both null when the setting is absent. */
export function registryAuthProof(env = process.env) {
  const raw = env.MCP_REGISTRY_AUTH_PROOF;
  if (raw === undefined || raw === null || String(raw).trim() === "") return { proof: null, error: null };
  const value = String(raw).trim();
  if (Buffer.byteLength(value, "utf8") > MCP_REGISTRY_AUTH_MAX_BYTES || !RECORD.test(value)) {
    return { proof: null, error: "MCP_REGISTRY_AUTH_PROOF is not a proof record (v=MCPv1; k=ed25519; p=<base64 public key>, or k=ecdsap384); the route stays off" };
  }
  return { proof: value, error: null };
}

/** Express handler: the record as text/plain, or the next handler (404). */
export function registryAuthHandler(env = process.env) {
  const { proof } = registryAuthProof(env);
  return (_req, res, next) => {
    if (!proof) return next();
    res.set("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send(`${proof}\n`);
  };
}
