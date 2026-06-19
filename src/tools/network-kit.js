// Network-kit (DNS + email auth) — closes the gap between the existing handful
// of network tools in kit.js (ip-info, tls-cert, whois, robots-check) and the
// daily-needed primitives every devops/email-deliverability/security audit
// reaches for. All upstreams are free public infrastructure:
//
//   • DNS — Node's built-in dns/promises module (no external API)
//   • SPF / DMARC / DKIM — parse the DNS TXT records ourselves (the specs are
//     short and self-contained; pulling in a dependency would be overkill)
//   • Multi-resolver propagation — dns.Resolver with setServers([...]) against
//     Google / Cloudflare / Quad9 / OpenDNS authoritative resolvers
//
// SSRF posture: DNS lookups can't be redirected to internal addresses (we never
// open a socket, we just resolve). The composite email-deliverability tool
// fans out 5–8 DNS queries; per-query timeouts cap the worst case at ~5s.
import { Resolver, promises as dnsPromises } from "node:dns";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Normalize whatever the caller sends as a "domain" / "host" / "url" / "email"
// down to a registrable hostname. Email gets the local-part stripped; URLs get
// reduced to hostname; trailing dots and case are normalized.
function normalizeHost(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Email → domain
  if (s.includes("@")) s = s.split("@").pop();
  // URL → hostname
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).hostname; } catch { /* fall through */ }
  }
  s = s.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)) return null;
  if (s.length > 253) return null;
  return s;
}

// Pluck the first identifier the caller is likely to have sent. Schemas declare
// the canonical name, but real agents flex on the key.
function pickHost(input, primary = "domain", aliases = ["host", "hostname", "url", "email"]) {
  for (const k of [primary, ...aliases]) {
    if (typeof input?.[k] === "string" && input[k].trim()) {
      const h = normalizeHost(input[k]);
      if (h) return h;
      throw bad(`Invalid ${primary}: "${input[k]}"`);
    }
  }
  throw bad(`Missing "${primary}". Send {"${primary}":"example.com"} (also accepts ${aliases.join("/")})`);
}

// Wrap dnsPromises.resolve(host, type) so the per-call timeout is enforced and
// upstream NXDOMAIN/NODATA become structured returns, not thrown errors.
async function resolveType(host, type, timeoutMs = 4000) {
  try {
    const records = await Promise.race([
      dnsPromises.resolve(host, type),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("DNS timeout"), { code: "ETIMEDOUT" })), timeoutMs)),
    ]);
    return { records, error: null };
  } catch (e) {
    // ENOTFOUND = NXDOMAIN; ENODATA = host exists but no records of that type.
    // Both are legitimate "no records" answers, not failures.
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") return { records: [], error: null };
    return { records: [], error: e.code || e.message };
  }
}

// dns.resolveTxt returns string[][] (each record is an array of chunks ≤255B
// because RFC 1035 limits a single TXT string; longer records are split).
// We join them so callers see one logical string per record.
function joinTxtRecords(arr) {
  return (arr || []).map((chunks) => Array.isArray(chunks) ? chunks.join("") : String(chunks));
}

// ────────── SPF parser ──────────
// Spec: RFC 7208. A record looks like:
//   v=spf1 ip4:192.0.2.0/24 include:_spf.google.com a mx ~all
// We tokenize, classify each token by mechanism + qualifier, and count the
// DNS lookups (include/a/mx/ptr/exists/redirect each cost 1 — the famous
// "10 DNS lookup" SPF limit).
function parseSpf(raw) {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.shift().toLowerCase() !== "v=spf1") return null;
  const mechanisms = [];
  let lookupCount = 0;
  let all = null;
  let redirect = null;
  for (const tok of tokens) {
    const m = tok.match(/^([+\-~?])?(\w+)(?::(.+))?$/i);
    if (!m) continue;
    const qualifier = ({ "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" })[m[1] || "+"];
    const mech = m[2].toLowerCase();
    const value = m[3] || null;
    if (mech === "all") { all = qualifier; mechanisms.push({ type: "all", qualifier }); continue; }
    if (mech === "redirect") { redirect = value; lookupCount++; mechanisms.push({ type: "redirect", value }); continue; }
    if (["include", "a", "mx", "ptr", "exists"].includes(mech)) lookupCount++;
    mechanisms.push({ type: mech, qualifier, value });
  }
  return { mechanisms, lookupCount, all, redirect };
}

// ────────── DMARC parser ──────────
// Spec: RFC 7489. Record looks like:
//   v=DMARC1; p=reject; sp=quarantine; rua=mailto:dmarc@example.com; pct=100
// Tags are semicolon-separated key=value pairs.
function parseDmarc(raw) {
  const parts = raw.trim().split(";").map((s) => s.trim()).filter(Boolean);
  const head = parts.shift();
  if (!head || head.toLowerCase() !== "v=dmarc1") return null;
  const tags = {};
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    if (!k || !rest.length) continue;
    tags[k.trim().toLowerCase()] = rest.join("=").trim();
  }
  return {
    policy: tags.p || "none",
    subdomainPolicy: tags.sp || tags.p || "none",
    percent: tags.pct != null ? Math.max(0, Math.min(100, parseInt(tags.pct, 10) || 0)) : 100,
    alignment: { spf: tags.aspf || "r", dkim: tags.adkim || "r" },
    reportingUris: {
      aggregate: (tags.rua || "").split(",").map((s) => s.trim()).filter(Boolean),
      failure: (tags.ruf || "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    interval: tags.ri ? parseInt(tags.ri, 10) : 86400,
    failureOptions: tags.fo || "0",
    rawTags: tags,
  };
}

// ────────── DKIM parser ──────────
// Spec: RFC 6376. TXT at <selector>._domainkey.<domain> looks like:
//   v=DKIM1; k=rsa; p=MIGfMA0G... (the public key, base64)
// We decode the key length from the base64 to surface "is this 1024 or 2048".
function parseDkim(raw) {
  const tags = {};
  for (const p of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, ...rest] = p.split("=");
    if (!k || !rest.length) continue;
    tags[k.trim().toLowerCase()] = rest.join("=").trim();
  }
  if (!tags.p && tags.v && tags.v.toLowerCase() !== "dkim1") return null;
  const publicKey = (tags.p || "").replace(/\s+/g, "");
  let bits = null;
  if (publicKey) {
    try {
      const der = Buffer.from(publicKey, "base64");
      // Conservative bit estimate from DER length (works for RSA + Ed25519).
      // Not cryptographically precise — operators care about the order of
      // magnitude (1024 vs 2048 vs 4096), and this is accurate to that.
      bits = der.length >= 270 ? 2048 : der.length >= 140 ? 1024 : der.length >= 60 ? 512 : null;
      if (der.length >= 540) bits = 4096;
    } catch { /* malformed base64 — leave null */ }
  }
  return {
    version: tags.v || "DKIM1",
    keyType: tags.k || "rsa",
    hashAlgorithms: (tags.h || "").split(":").map((s) => s.trim()).filter(Boolean),
    serviceType: tags.s || "*",
    flags: (tags.t || "").split(":").map((s) => s.trim()).filter(Boolean),
    publicKey: { base64: publicKey || null, bits, revoked: publicKey === "" },
  };
}

// Used by email-deliverability to probe likely DKIM selectors when the caller
// hasn't told us which one to look up. Order matters: most-common providers
// first so we usually hit on the first probe.
const COMMON_DKIM_SELECTORS = [
  "google", "selector1", "selector2", "default", "k1", "k2", "mxvault",
  "dkim", "mail", "smtp", "s1", "s2", "20230601", "20221208",
];

export const NETWORK_TOOLS = [
  // ────────── Tool 1: dns-lookup ──────────
  {
    route: "POST /api/dns-lookup",
    name: "DNS lookup",
    slug: "dns-lookup",
    category: "network",
    price: "$0.002",
    description:
      "Resolve any DNS record type for a host: A, AAAA, MX, TXT, CNAME, NS, SOA, CAA, SRV, PTR. Returns the records plus a count. Built on Node's native resolver — no external API.",
    tags: ["dns", "lookup", "network", "diagnostic", "a", "aaaa", "mx", "txt", "cname", "ns"],
    discovery: {
      bodyType: "json",
      input: { host: "google.com", type: "MX" },
      inputSchema: {
        properties: {
          host: { type: "string", description: "Hostname to resolve" },
          type: { type: "string", description: "Record type: A, AAAA, MX, TXT, CNAME, NS, SOA, CAA, SRV (default A)" },
        },
        required: ["host"],
      },
      output: {
        example: {
          host: "google.com",
          type: "MX",
          records: [{ priority: 10, exchange: "smtp.google.com" }],
          count: 1,
          queriedAt: "2026-06-19T20:00:00.000Z",
        },
      },
    },
    handler: async (input) => {
      const host = pickHost(input);
      const type = String(input.type || "A").trim().toUpperCase();
      if (!["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "CAA", "SRV", "PTR"].includes(type)) {
        throw bad(`Unsupported type "${type}". Valid: A, AAAA, MX, TXT, CNAME, NS, SOA, CAA, SRV, PTR`);
      }
      const { records, error } = await resolveType(host, type);
      // TXT records come back as string[][] — flatten the inner chunks.
      const out = type === "TXT" ? joinTxtRecords(records) : records;
      return {
        host,
        type,
        records: out,
        count: out.length,
        queriedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      };
    },
  },

  // ────────── Tool 2: dns-propagation ──────────
  {
    route: "POST /api/dns-propagation",
    name: "DNS propagation check",
    slug: "dns-propagation",
    category: "network",
    price: "$0.003",
    description:
      "Resolve the same DNS record against 4 public resolvers (Google, Cloudflare, Quad9, OpenDNS) in parallel; surface divergences. The first call you make after a DNS change — confirms the world sees what you intended.",
    tags: ["dns", "propagation", "network", "diagnostic", "migration", "resolver"],
    discovery: {
      bodyType: "json",
      input: { host: "google.com", type: "A" },
      inputSchema: {
        properties: {
          host: { type: "string", description: "Hostname to resolve" },
          type: { type: "string", description: "Record type (default A)" },
        },
        required: ["host"],
      },
      output: {
        example: {
          host: "google.com",
          type: "A",
          consistent: true,
          resolvers: [
            { resolver: "8.8.8.8", name: "Google", records: ["142.250.80.46"], count: 1 },
            { resolver: "1.1.1.1", name: "Cloudflare", records: ["142.250.80.46"], count: 1 },
            { resolver: "9.9.9.9", name: "Quad9", records: ["142.250.80.46"], count: 1 },
            { resolver: "208.67.222.222", name: "OpenDNS", records: ["142.250.80.46"], count: 1 },
          ],
          queriedAt: "2026-06-19T20:00:00.000Z",
        },
      },
    },
    handler: async (input) => {
      const host = pickHost(input);
      const type = String(input.type || "A").trim().toUpperCase();
      if (!["A", "AAAA", "MX", "TXT", "CNAME", "NS"].includes(type)) {
        throw bad(`Unsupported type "${type}" for propagation. Valid: A, AAAA, MX, TXT, CNAME, NS`);
      }
      const RESOLVERS = [
        { resolver: "8.8.8.8", name: "Google" },
        { resolver: "1.1.1.1", name: "Cloudflare" },
        { resolver: "9.9.9.9", name: "Quad9" },
        { resolver: "208.67.222.222", name: "OpenDNS" },
      ];
      const results = await Promise.all(
        RESOLVERS.map(async ({ resolver, name }) => {
          const r = new Resolver();
          r.setServers([resolver]);
          // node's class-based Resolver still returns callback-based fns by
          // default — wrap one call manually.
          const records = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ err: "timeout", recs: [] }), 4000);
            r.resolve(host, type, (err, recs) => {
              clearTimeout(timer);
              resolve({ err: err ? (err.code || err.message) : null, recs: recs || [] });
            });
          });
          const recs = type === "TXT" ? joinTxtRecords(records.recs) : records.recs;
          return { resolver, name, records: recs, count: recs.length, ...(records.err && records.err !== "ENODATA" && records.err !== "ENOTFOUND" ? { error: records.err } : {}) };
        })
      );
      // Consistency: every resolver returned the same (order-insensitive) set.
      const fingerprint = (recs) => JSON.stringify([...recs].map((r) => (typeof r === "object" ? JSON.stringify(r) : String(r))).sort());
      const fingerprints = new Set(results.filter((r) => !r.error).map((r) => fingerprint(r.records)));
      return {
        host,
        type,
        consistent: fingerprints.size <= 1,
        resolvers: results,
        queriedAt: new Date().toISOString(),
      };
    },
  },

  // ────────── Tool 3: spf-check ──────────
  {
    route: "POST /api/spf-check",
    name: "SPF check",
    slug: "spf-check",
    category: "network",
    price: "$0.003",
    description:
      "Fetch and validate a domain's SPF record (RFC 7208). Parses mechanisms (ip4/ip6/include/a/mx/all), counts DNS lookups against the famous 10-lookup limit, and flags the qualifier on `all` (-/fail, ~/softfail, ?/neutral). The first stop when an email is hitting the spam folder.",
    tags: ["spf", "email", "email-auth", "deliverability", "dns", "rfc7208"],
    discovery: {
      bodyType: "json",
      input: { domain: "google.com" },
      inputSchema: {
        properties: { domain: { type: "string", description: "Domain name (also accepts email/url/host)" } },
        required: ["domain"],
      },
      output: {
        example: {
          domain: "google.com",
          hasRecord: true,
          raw: "v=spf1 include:_spf.google.com ~all",
          mechanisms: [
            { type: "include", qualifier: "pass", value: "_spf.google.com" },
            { type: "all", qualifier: "softfail" },
          ],
          lookupCount: 1,
          all: "softfail",
          valid: true,
          warnings: [],
        },
      },
    },
    handler: async (input) => {
      const domain = pickHost(input, "domain");
      const { records, error } = await resolveType(domain, "TXT");
      if (error) throw bad(`DNS lookup failed for ${domain}: ${error}`, 502);
      const txt = joinTxtRecords(records);
      const spf = txt.find((r) => /^v=spf1\b/i.test(r));
      if (!spf) {
        return {
          domain,
          hasRecord: false,
          raw: null,
          mechanisms: [],
          lookupCount: 0,
          all: null,
          valid: false,
          warnings: ["No SPF record found — mail from this domain will fail SPF at every receiver"],
        };
      }
      const parsed = parseSpf(spf);
      const warnings = [];
      if (parsed.lookupCount > 10) warnings.push(`SPF lookup count (${parsed.lookupCount}) exceeds the RFC 7208 limit of 10 — receivers will return PermError`);
      if (parsed.all === "pass") warnings.push('Qualifier on "all" is "+pass" — accepts mail from any sender, defeats the purpose of SPF');
      if (parsed.all === "neutral") warnings.push('Qualifier on "all" is "?neutral" — receivers will not act on SPF failures');
      if (!parsed.all && !parsed.redirect) warnings.push('No "all" mechanism and no redirect — receivers may interpret as PermError');
      return {
        domain,
        hasRecord: true,
        raw: spf,
        mechanisms: parsed.mechanisms,
        lookupCount: parsed.lookupCount,
        all: parsed.all,
        ...(parsed.redirect ? { redirect: parsed.redirect } : {}),
        valid: parsed.lookupCount <= 10 && (!!parsed.all || !!parsed.redirect),
        warnings,
      };
    },
  },

  // ────────── Tool 4: dmarc-check ──────────
  {
    route: "POST /api/dmarc-check",
    name: "DMARC check",
    slug: "dmarc-check",
    category: "network",
    price: "$0.003",
    description:
      "Fetch and validate a domain's DMARC policy at _dmarc.<domain> (RFC 7489). Surfaces the enforcement policy (none/quarantine/reject), reporting addresses, alignment modes, and common misconfigs (no rua, p=none stuck for months, percent <100). Pair with SPF and DKIM for full Feb-2024 sender-rule compliance.",
    tags: ["dmarc", "email", "email-auth", "deliverability", "dns", "rfc7489"],
    discovery: {
      bodyType: "json",
      input: { domain: "google.com" },
      inputSchema: {
        properties: { domain: { type: "string", description: "Domain name (also accepts email/url/host)" } },
        required: ["domain"],
      },
      output: {
        example: {
          domain: "google.com",
          hasRecord: true,
          raw: "v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com",
          policy: "reject",
          subdomainPolicy: "reject",
          percent: 100,
          alignment: { spf: "r", dkim: "r" },
          reportingUris: { aggregate: ["mailto:mailauth-reports@google.com"], failure: [] },
          valid: true,
          warnings: [],
        },
      },
    },
    handler: async (input) => {
      const domain = pickHost(input, "domain");
      const { records, error } = await resolveType(`_dmarc.${domain}`, "TXT");
      if (error) throw bad(`DNS lookup failed for _dmarc.${domain}: ${error}`, 502);
      const txt = joinTxtRecords(records);
      const dmarc = txt.find((r) => /^v=DMARC1\b/i.test(r));
      if (!dmarc) {
        return {
          domain,
          hasRecord: false,
          raw: null,
          policy: null,
          subdomainPolicy: null,
          percent: 0,
          alignment: { spf: null, dkim: null },
          reportingUris: { aggregate: [], failure: [] },
          valid: false,
          warnings: ["No DMARC record found — mail from this domain has no enforcement policy and no reporting"],
        };
      }
      const parsed = parseDmarc(dmarc);
      if (!parsed) {
        return {
          domain,
          hasRecord: true,
          raw: dmarc,
          policy: null,
          subdomainPolicy: null,
          percent: 0,
          alignment: { spf: null, dkim: null },
          reportingUris: { aggregate: [], failure: [] },
          valid: false,
          warnings: ["DMARC record present but malformed (missing v=DMARC1 header)"],
        };
      }
      const warnings = [];
      if (parsed.policy === "none") warnings.push('Policy is "p=none" — DMARC is in monitor-only mode, receivers will not reject failing mail');
      if (parsed.percent < 100) warnings.push(`Only ${parsed.percent}% of failing mail is subject to the policy — the rest passes through`);
      if (!parsed.reportingUris.aggregate.length) warnings.push("No rua (aggregate report) address — you receive no DMARC visibility");
      return {
        domain,
        hasRecord: true,
        raw: dmarc,
        policy: parsed.policy,
        subdomainPolicy: parsed.subdomainPolicy,
        percent: parsed.percent,
        alignment: parsed.alignment,
        reportingUris: parsed.reportingUris,
        valid: parsed.policy === "quarantine" || parsed.policy === "reject",
        warnings,
      };
    },
  },

  // ────────── Tool 5: dkim-lookup ──────────
  {
    route: "POST /api/dkim-lookup",
    name: "DKIM key lookup",
    slug: "dkim-lookup",
    category: "network",
    price: "$0.003",
    description:
      "Fetch and parse a DKIM public-key record at <selector>._domainkey.<domain> (RFC 6376). Returns the parsed key params (algorithm, length, flags) so you can verify rotation status or key strength. Caller must know the selector — use email-deliverability if you don't.",
    tags: ["dkim", "email", "email-auth", "deliverability", "dns", "rfc6376"],
    discovery: {
      bodyType: "json",
      input: { domain: "google.com", selector: "20221208" },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Domain name (also accepts email/url/host)" },
          selector: { type: "string", description: "DKIM selector, e.g. \"default\", \"google\", \"selector1\"" },
        },
        required: ["domain", "selector"],
      },
      output: {
        example: {
          domain: "google.com",
          selector: "20221208",
          fullName: "20221208._domainkey.google.com",
          hasRecord: true,
          raw: "v=DKIM1; k=rsa; p=MIIBIj...",
          version: "DKIM1",
          keyType: "rsa",
          hashAlgorithms: [],
          serviceType: "*",
          flags: [],
          publicKey: { base64: "MIIBIj...", bits: 2048, revoked: false },
          warnings: [],
        },
      },
    },
    handler: async (input) => {
      const domain = pickHost(input, "domain");
      const selector = String(input.selector || "").trim();
      if (!selector) throw bad('Missing "selector". Send {"domain":"example.com","selector":"default"}');
      if (!/^[a-zA-Z0-9._-]+$/.test(selector)) throw bad("Invalid selector — letters, digits, dot, hyphen, underscore only");
      const fullName = `${selector}._domainkey.${domain}`;
      const { records, error } = await resolveType(fullName, "TXT");
      if (error) throw bad(`DNS lookup failed for ${fullName}: ${error}`, 502);
      const txt = joinTxtRecords(records);
      // DKIM records often don't start with v=DKIM1 (it's optional in spec, common in practice).
      // Identify by presence of "p=" or "k=" instead.
      const dkim = txt.find((r) => /(\bv=DKIM1\b|\bp=|\bk=)/i.test(r));
      if (!dkim) {
        return {
          domain,
          selector,
          fullName,
          hasRecord: false,
          raw: null,
          version: null,
          keyType: null,
          hashAlgorithms: [],
          serviceType: null,
          flags: [],
          publicKey: { base64: null, bits: null, revoked: false },
          warnings: [`No DKIM record at ${fullName} — selector may not exist for this domain`],
        };
      }
      const parsed = parseDkim(dkim);
      if (!parsed) {
        return {
          domain,
          selector,
          fullName,
          hasRecord: true,
          raw: dkim,
          version: null,
          keyType: null,
          hashAlgorithms: [],
          serviceType: null,
          flags: [],
          publicKey: { base64: null, bits: null, revoked: false },
          warnings: ["DKIM record present but unparseable"],
        };
      }
      const warnings = [];
      if (parsed.publicKey.revoked) warnings.push("Public key is empty — DKIM selector is revoked (rotated out)");
      if (parsed.publicKey.bits && parsed.publicKey.bits < 1024) warnings.push(`Public key is only ${parsed.publicKey.bits} bits — Google/Yahoo require ≥1024 since 2024`);
      if (parsed.flags.includes("y")) warnings.push('Flag "y" set — domain is in DKIM testing mode (receivers should not reject)');
      return {
        domain,
        selector,
        fullName,
        hasRecord: true,
        raw: dkim,
        version: parsed.version,
        keyType: parsed.keyType,
        hashAlgorithms: parsed.hashAlgorithms,
        serviceType: parsed.serviceType,
        flags: parsed.flags,
        publicKey: parsed.publicKey,
        warnings,
      };
    },
  },

  // ────────── Tool 6: email-deliverability ──────────
  {
    route: "POST /api/email-deliverability",
    name: "Email deliverability check",
    slug: "email-deliverability",
    category: "network",
    price: "$0.005",
    description:
      "End-to-end email-auth report for a domain: SPF + DMARC + DKIM (probes common selectors automatically) + MX records + score 0–100. The one call to make when 'why is our mail going to spam?' lands in your inbox.",
    tags: ["email", "email-auth", "deliverability", "spf", "dmarc", "dkim", "mx", "audit"],
    discovery: {
      bodyType: "json",
      input: { domain: "google.com" },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Domain name (also accepts email/url/host)" },
          dkimSelectors: { type: "array", description: "Optional DKIM selectors to probe (overrides default list of 14 common selectors)" },
        },
        required: ["domain"],
      },
      output: {
        example: {
          domain: "google.com",
          score: 90,
          summary: "good",
          spf: { hasRecord: true, all: "softfail", valid: true, lookupCount: 1 },
          dmarc: { hasRecord: true, policy: "reject", percent: 100, valid: true },
          dkim: { found: [{ selector: "20221208", bits: 2048, valid: true }], probed: ["google", "selector1", "default", "20221208"] },
          mx: { count: 5, records: ["smtp.google.com"] },
          checks: [
            { check: "spf", status: "pass", detail: "SPF record present, 1 DNS lookup, ~all qualifier" },
            { check: "dmarc", status: "pass", detail: "p=reject at 100% — strict enforcement" },
            { check: "dkim", status: "pass", detail: "Found DKIM at selector 20221208 (2048-bit RSA)" },
            { check: "mx", status: "pass", detail: "5 MX records configured" },
          ],
          queriedAt: "2026-06-19T20:00:00.000Z",
        },
      },
    },
    handler: async (input) => {
      const domain = pickHost(input, "domain");
      const selectors = Array.isArray(input.dkimSelectors) && input.dkimSelectors.length
        ? input.dkimSelectors.slice(0, 20).map((s) => String(s).trim()).filter((s) => /^[a-zA-Z0-9._-]+$/.test(s))
        : COMMON_DKIM_SELECTORS;
      // Fan out: SPF + DMARC + MX + every DKIM selector probe, all in parallel.
      const [spfTxt, dmarcTxt, mxRecs, ...dkimResults] = await Promise.all([
        resolveType(domain, "TXT"),
        resolveType(`_dmarc.${domain}`, "TXT"),
        resolveType(domain, "MX"),
        ...selectors.map((sel) => resolveType(`${sel}._domainkey.${domain}`, "TXT")),
      ]);
      // SPF
      const spfRaw = joinTxtRecords(spfTxt.records).find((r) => /^v=spf1\b/i.test(r));
      const spfParsed = spfRaw ? parseSpf(spfRaw) : null;
      const spfValid = !!(spfParsed && spfParsed.lookupCount <= 10 && (spfParsed.all || spfParsed.redirect));
      // DMARC
      const dmarcRaw = joinTxtRecords(dmarcTxt.records).find((r) => /^v=DMARC1\b/i.test(r));
      const dmarcParsed = dmarcRaw ? parseDmarc(dmarcRaw) : null;
      const dmarcValid = !!(dmarcParsed && (dmarcParsed.policy === "quarantine" || dmarcParsed.policy === "reject"));
      // DKIM — only keep selectors that actually returned a record
      const foundDkim = [];
      dkimResults.forEach((r, i) => {
        const raw = joinTxtRecords(r.records).find((t) => /(\bv=DKIM1\b|\bp=|\bk=)/i.test(t));
        if (!raw) return;
        const p = parseDkim(raw);
        if (!p) return;
        foundDkim.push({
          selector: selectors[i],
          bits: p.publicKey.bits,
          keyType: p.keyType,
          revoked: p.publicKey.revoked,
          valid: !p.publicKey.revoked && (!p.publicKey.bits || p.publicKey.bits >= 1024),
        });
      });
      // MX
      const mx = mxRecs.records || [];
      const mxHosts = mx.map((r) => r.exchange).filter(Boolean);
      // Score: 25 SPF + 25 DMARC + 25 DKIM + 25 MX. Partial credit for partial wins.
      let score = 0;
      const checks = [];
      if (spfValid) { score += 25; checks.push({ check: "spf", status: "pass", detail: `SPF record present, ${spfParsed.lookupCount} DNS lookup${spfParsed.lookupCount === 1 ? "" : "s"}, ${spfParsed.all ? `${({ fail: "-", softfail: "~", neutral: "?", pass: "+" })[spfParsed.all]}all` : "no all"} qualifier` }); }
      else if (spfRaw) { score += 10; checks.push({ check: "spf", status: "warn", detail: spfParsed?.lookupCount > 10 ? `SPF record exceeds 10-lookup limit (${spfParsed.lookupCount})` : "SPF record present but invalid" }); }
      else checks.push({ check: "spf", status: "fail", detail: "No SPF record" });
      if (dmarcValid) { score += 25; checks.push({ check: "dmarc", status: "pass", detail: `p=${dmarcParsed.policy} at ${dmarcParsed.percent}%${dmarcParsed.percent === 100 ? " — strict enforcement" : ""}` }); }
      else if (dmarcRaw) { score += 10; checks.push({ check: "dmarc", status: "warn", detail: `p=${dmarcParsed?.policy || "?"} — monitor-only, no enforcement` }); }
      else checks.push({ check: "dmarc", status: "fail", detail: "No DMARC record" });
      if (foundDkim.some((d) => d.valid)) {
        score += 25;
        const best = foundDkim.find((d) => d.valid);
        checks.push({ check: "dkim", status: "pass", detail: `Found DKIM at selector ${best.selector} (${best.bits ? `${best.bits}-bit ${best.keyType.toUpperCase()}` : best.keyType})` });
      } else if (foundDkim.length) { score += 10; checks.push({ check: "dkim", status: "warn", detail: `DKIM found but ${foundDkim[0].revoked ? "revoked" : "weak key"}` }); }
      else checks.push({ check: "dkim", status: "fail", detail: `No DKIM at probed selectors (${selectors.length} tried)` });
      if (mxHosts.length) { score += 25; checks.push({ check: "mx", status: "pass", detail: `${mxHosts.length} MX record${mxHosts.length === 1 ? "" : "s"} configured` }); }
      else checks.push({ check: "mx", status: "fail", detail: "No MX records — domain cannot receive mail" });
      const summary = score >= 90 ? "good" : score >= 60 ? "warn" : "fail";
      return {
        domain,
        score,
        summary,
        spf: { hasRecord: !!spfRaw, all: spfParsed?.all || null, valid: spfValid, lookupCount: spfParsed?.lookupCount ?? 0 },
        dmarc: { hasRecord: !!dmarcRaw, policy: dmarcParsed?.policy || null, percent: dmarcParsed?.percent ?? 0, valid: dmarcValid },
        dkim: { found: foundDkim, probed: selectors },
        mx: { count: mxHosts.length, records: mxHosts.slice(0, 10) },
        checks,
        queriedAt: new Date().toISOString(),
      };
    },
  },
];
