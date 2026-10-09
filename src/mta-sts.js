// MTA-STS policy (RFC 8461) served at /.well-known/mta-sts.txt on the
// mta-sts.<domain> host. The DNS side (the _mta-sts TXT record naming a policy
// id, and the host's A/CNAME) is published separately; this is the policy
// text. The mail hosts are configuration (MTA_STS_MX, comma-separated): with
// none set there is no policy to serve.
const MODES = new Set(["testing", "enforce", "none"]);

export function mtaStsPolicy(env = process.env) {
  const mx = String(env.MTA_STS_MX || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9.*-]+$/.test(s));
  if (!mx.length) return null;
  const mode = MODES.has(String(env.MTA_STS_MODE || "").toLowerCase()) ? String(env.MTA_STS_MODE).toLowerCase() : "testing";
  const maxAge = Math.min(31_557_600, Math.max(86_400, Number(env.MTA_STS_MAX_AGE) || 86_400));
  return [`version: STSv1`, `mode: ${mode}`, ...mx.map((h) => `mx: ${h}`), `max_age: ${maxAge}`].join("\r\n") + "\r\n";
}
