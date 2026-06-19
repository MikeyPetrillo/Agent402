// Network-kit (cert + HTTP + IP) — second half of the network/security primitive
// set, complementing network-kit.js (DNS + email auth). All upstreams are free
// public infrastructure:
//
//   • cert-transparency — crt.sh (Sectigo's public CT log search) returns JSON
//   • http-headers — direct fetch with the shared SSRF dispatcher
//   • tech-stack — safeFetch + signature scan against a small built-in table
//   • asn-info — Team Cymru's DNS-based whois (TXT records on a special zone)
//
// SSRF posture: http-headers and tech-stack route through assertPublicUrl +
// ssrfDispatcher, the same guards every URL-fetching tool in the catalog uses.
// asn-info accepts an IP literal or a hostname (resolved via the public DNS
// resolver), and the resulting reverse-lookup is to a public Team Cymru zone.
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { assertPublicUrl, ssrfDispatcher, safeFetch } from "./fetch-guard.js";

const USER_AGENT =
  (process.env.NETWORK_KIT_USER_AGENT || "").trim() ||
  "Agent402/1.0 (+https://agent402.tools)";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Mirror of network-kit.js's input picker so an agent sending {url}, {host},
// {hostname}, {domain}, or {email} all work the same way across the kit.
function normalizeHost(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@").pop();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).hostname; } catch { return null; }
  }
  s = s.replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

function pickHost(input, keys = ["domain", "host", "hostname", "url", "email"]) {
  for (const k of keys) {
    if (input && typeof input[k] === "string") {
      const h = normalizeHost(input[k]);
      if (h) return h;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────── cert-transparency

async function certTransparencyHandler(body) {
  const domain = pickHost(body);
  if (!domain) throw bad('Missing "domain". Send {"domain":"example.com"} (also accepts host/hostname/url/email)');
  const includeExpired = body?.includeExpired === true;
  const limit = Math.max(1, Math.min(500, Number(body?.limit) || 50));

  // crt.sh supports JSON output via ?output=json. Queries are slow but free and
  // require no auth. We use the % wildcard prefix to match all subdomains.
  const q = encodeURIComponent("%." + domain);
  const url = `https://crt.sh/?q=${q}&output=json${includeExpired ? "" : "&exclude=expired"}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      dispatcher: ssrfDispatcher,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (err) {
    if (err.name === "AbortError") throw bad("crt.sh did not respond within 12s — try again later", 504);
    throw bad(`Could not reach crt.sh: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw bad(`crt.sh returned HTTP ${response.status} — try again later`, response.status >= 500 ? 502 : 422);
  }
  const text = await response.text();
  let rows;
  try { rows = JSON.parse(text); } catch { throw bad("crt.sh returned non-JSON — try again later", 502); }
  if (!Array.isArray(rows)) rows = [];

  // Dedupe by serial (one cert can be logged in multiple CT logs).
  const seen = new Set();
  const certs = [];
  for (const r of rows) {
    const key = r.serial_number || `${r.issuer_ca_id}-${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sans = String(r.name_value || "").split("\n").map(s => s.trim()).filter(Boolean);
    certs.push({
      id: r.id,
      serial: r.serial_number || null,
      issuer: r.issuer_name || null,
      commonName: r.common_name || null,
      sans,
      notBefore: r.not_before || null,
      notAfter: r.not_after || null,
    });
    if (certs.length >= limit) break;
  }

  // Surface the unique subdomain set — the most actionable output for a
  // security audit ("what subdomains do we have certs for?").
  const subdomains = new Set();
  for (const c of certs) {
    for (const s of c.sans) {
      if (!s.startsWith("*.") && s.endsWith(domain)) subdomains.add(s.toLowerCase());
    }
  }

  return {
    domain,
    count: certs.length,
    truncated: rows.length > certs.length,
    subdomains: [...subdomains].sort(),
    certs,
    queriedAt: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────── http-headers

// Security headers we recognize, with a presence-only scoring weight (0–100).
const SECURITY_HEADERS = [
  { key: "strict-transport-security", short: "HSTS", weight: 20 },
  { key: "content-security-policy",    short: "CSP",  weight: 25 },
  { key: "x-frame-options",            short: "XFO",  weight: 10 },
  { key: "x-content-type-options",     short: "XCTO", weight: 10 },
  { key: "referrer-policy",            short: "RP",   weight: 10 },
  { key: "permissions-policy",         short: "PP",   weight: 10 },
  { key: "cross-origin-opener-policy", short: "COOP", weight: 5 },
  { key: "cross-origin-resource-policy", short: "CORP", weight: 5 },
  { key: "cross-origin-embedder-policy", short: "COEP", weight: 5 },
];

function analyzeSecurity(headers) {
  const findings = [];
  let score = 0;
  for (const def of SECURITY_HEADERS) {
    const v = headers[def.key];
    if (v) {
      score += def.weight;
      findings.push({ header: def.short, present: true, value: v });
    } else {
      findings.push({ header: def.short, present: false, value: null });
    }
  }
  // Penalize a weak HSTS — under 6 months is widely considered too short to
  // protect against an active downgrade attack.
  const hsts = headers["strict-transport-security"];
  const warnings = [];
  if (hsts) {
    const m = hsts.match(/max-age\s*=\s*(\d+)/i);
    const seconds = m ? parseInt(m[1], 10) : 0;
    if (seconds < 15552000) warnings.push("HSTS max-age is below 180 days (recommended ≥6mo)");
    if (!/includeSubDomains/i.test(hsts)) warnings.push("HSTS does not includeSubDomains");
  }
  if (headers["server"]) warnings.push(`Server header leaks identity: ${headers["server"]}`);
  if (headers["x-powered-by"]) warnings.push(`X-Powered-By leaks identity: ${headers["x-powered-by"]}`);
  return { score: Math.min(100, score), findings, warnings };
}

async function httpHeadersHandler(body) {
  const raw = body?.url || body?.href || body?.target;
  if (typeof raw !== "string" || !raw.trim()) throw bad('Missing "url". Send {"url":"https://example.com"}');
  const parsed = await assertPublicUrl(raw);
  const method = (body?.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) throw bad('"method" must be GET or HEAD');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(parsed, {
      method,
      signal: controller.signal,
      redirect: "follow",
      dispatcher: ssrfDispatcher,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    });
  } catch (err) {
    if (err.name === "AbortError") throw bad("Target did not respond within 10s", 504);
    throw bad(`Could not reach target: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  // Drain to free the socket (we only care about headers).
  try { await response.arrayBuffer(); } catch {}

  const headers = {};
  for (const [k, v] of response.headers.entries()) headers[k.toLowerCase()] = v;
  const security = analyzeSecurity(headers);

  return {
    url: parsed.toString(),
    finalUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    httpVersion: null, // Node fetch does not expose this; reserved for future use.
    headers,
    security,
    fetchedAt: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────── tech-stack

// Compact signature table. Each entry: { category, name, header, headerValue, html, generator }.
// At least one of header/html/generator must match. Header values are
// case-insensitive substring matches; HTML matches are regex; generator matches
// the <meta name="generator"> content (substring, case-insensitive).
const TECH_SIGNATURES = [
  // CDN / edge
  { category: "cdn", name: "Cloudflare",     header: "cf-ray" },
  { category: "cdn", name: "Cloudflare",     header: "server", headerValue: "cloudflare" },
  { category: "cdn", name: "Vercel",         header: "x-vercel-id" },
  { category: "cdn", name: "Vercel",         header: "server", headerValue: "vercel" },
  { category: "cdn", name: "Netlify",        header: "server", headerValue: "netlify" },
  { category: "cdn", name: "Fastly",         header: "x-served-by", headerValue: "cache-" },
  { category: "cdn", name: "Fastly",         header: "x-fastly-request-id" },
  { category: "cdn", name: "Amazon CloudFront", header: "x-amz-cf-id" },
  { category: "cdn", name: "Akamai",         header: "x-akamai-transformed" },
  { category: "cdn", name: "Bunny",          header: "server", headerValue: "bunnycdn" },
  // Web servers
  { category: "server", name: "nginx",       header: "server", headerValue: "nginx" },
  { category: "server", name: "Apache",      header: "server", headerValue: "apache" },
  { category: "server", name: "Caddy",       header: "server", headerValue: "caddy" },
  { category: "server", name: "LiteSpeed",   header: "server", headerValue: "litespeed" },
  { category: "server", name: "Microsoft IIS", header: "server", headerValue: "iis" },
  // Languages / runtimes
  { category: "language", name: "PHP",       header: "x-powered-by", headerValue: "php" },
  { category: "language", name: "ASP.NET",   header: "x-powered-by", headerValue: "asp.net" },
  { category: "language", name: "Express",   header: "x-powered-by", headerValue: "express" },
  { category: "language", name: "Ruby on Rails", header: "x-powered-by", headerValue: "rails" },
  // Frameworks (HTML signals)
  { category: "framework", name: "Next.js",  html: /id=["']__next["']|\/_next\/static\//i },
  { category: "framework", name: "Nuxt",     html: /id=["']__nuxt["']|\/_nuxt\//i },
  { category: "framework", name: "SvelteKit", html: /data-svelte|kit\.start\(/i },
  { category: "framework", name: "Remix",    html: /window\.__remixContext|\/build\/_assets\//i },
  { category: "framework", name: "Astro",    html: /astro-island|<astro-/i },
  { category: "framework", name: "React",    html: /data-reactroot|data-reactid/i },
  { category: "framework", name: "Vue.js",   html: /id=["']app["'][^>]*data-v-app|__vue__/i },
  { category: "framework", name: "Angular",  html: /ng-version=|ng-app=/i },
  // CMS / generator
  { category: "cms", name: "WordPress",      html: /\/wp-content\/|\/wp-includes\//i },
  { category: "cms", name: "WordPress",      generator: "wordpress" },
  { category: "cms", name: "Drupal",         generator: "drupal" },
  { category: "cms", name: "Joomla",         generator: "joomla" },
  { category: "cms", name: "Ghost",          generator: "ghost" },
  { category: "cms", name: "Hugo",           generator: "hugo" },
  { category: "cms", name: "Jekyll",         generator: "jekyll" },
  { category: "cms", name: "Webflow",        html: /webflow\.com\/|data-wf-page/i },
  { category: "cms", name: "Shopify",        html: /cdn\.shopify\.com|Shopify\.theme/i },
  { category: "cms", name: "Wix",            html: /static\.wixstatic\.com|wix-warmup-data/i },
  { category: "cms", name: "Squarespace",    html: /static\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i },
  // Analytics
  { category: "analytics", name: "Google Analytics", html: /googletagmanager\.com\/gtag|google-analytics\.com\/ga\.js|gtag\(['"]config/i },
  { category: "analytics", name: "Google Tag Manager", html: /googletagmanager\.com\/gtm/i },
  { category: "analytics", name: "PostHog",  html: /posthog\.com\/static|posthog\.init\(/i },
  { category: "analytics", name: "Mixpanel", html: /cdn\.mixpanel\.com|mixpanel\.init\(/i },
  { category: "analytics", name: "Segment",  html: /cdn\.segment\.com|analytics\.load\(/i },
  { category: "analytics", name: "Hotjar",   html: /static\.hotjar\.com/i },
  { category: "analytics", name: "Plausible", html: /plausible\.io\/js/i },
  { category: "analytics", name: "Fathom",   html: /cdn\.usefathom\.com/i },
  // Payments
  { category: "payments", name: "Stripe",    html: /js\.stripe\.com|stripe\.com\/v3/i },
  { category: "payments", name: "PayPal",    html: /paypal\.com\/sdk\/js/i },
];

function extractGenerator(html) {
  const m = html.match(/<meta\s+[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i);
  return m ? m[1].toLowerCase() : "";
}

function detectTech(headers, html) {
  const hits = new Map();
  const generator = extractGenerator(html);
  for (const sig of TECH_SIGNATURES) {
    let matched = false;
    if (sig.header) {
      const v = headers[sig.header];
      if (v) {
        if (!sig.headerValue || v.toLowerCase().includes(sig.headerValue)) matched = true;
      }
    }
    if (!matched && sig.html && sig.html.test(html)) matched = true;
    if (!matched && sig.generator && generator.includes(sig.generator)) matched = true;
    if (matched) {
      const key = `${sig.category}::${sig.name}`;
      if (!hits.has(key)) hits.set(key, { category: sig.category, name: sig.name });
    }
  }
  return [...hits.values()];
}

async function techStackHandler(body) {
  const raw = body?.url || body?.href || body?.target;
  if (typeof raw !== "string" || !raw.trim()) throw bad('Missing "url". Send {"url":"https://example.com"}');
  // safeFetch handles SSRF, redirects, size cap, timeout, and honest 4xx/5xx
  // attribution. We just need the final HTML + headers.
  const { finalUrl, html } = await safeFetch(raw, { maxBytes: 256 * 1024 });
  // safeFetch doesn't return response headers — re-fetch HEAD for headers only.
  // If HEAD is rejected, fall back to an empty headers object: the HTML signals
  // alone still catch most frameworks/CMSes.
  let headers = {};
  try {
    const parsed = await assertPublicUrl(finalUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(parsed, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
        dispatcher: ssrfDispatcher,
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      });
      for (const [k, v] of r.headers.entries()) headers[k.toLowerCase()] = v;
    } finally { clearTimeout(timer); }
  } catch { /* HEAD-failure tolerated; HTML still drives detection */ }

  const detected = detectTech(headers, html);
  const byCategory = {};
  for (const d of detected) {
    if (!byCategory[d.category]) byCategory[d.category] = [];
    byCategory[d.category].push(d.name);
  }
  return {
    url: finalUrl,
    detected,
    byCategory,
    generator: extractGenerator(html) || null,
    server: headers["server"] || null,
    poweredBy: headers["x-powered-by"] || null,
    fetchedAt: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────── asn-info

// Team Cymru exposes IP→ASN mapping via specially-formatted DNS TXT queries:
//   <reverse-ip>.origin.asn.cymru.com → "AS | prefix | CC | registry | date"
//   AS<num>.asn.cymru.com             → "AS | CC | registry | date | name"
// This is free, fast, unauthenticated, and pure DNS — no HTTPS upstream needed.
// Docs: https://team-cymru.com/community-services/ip-asn-mapping/
function reverseIpv4(ip) {
  return ip.split(".").reverse().join(".");
}

async function asnInfoHandler(body) {
  let ip = body?.ip || body?.address;
  if (!ip) {
    const host = pickHost(body, ["host", "hostname", "domain", "url", "email"]);
    if (host) {
      try { ip = (await dnsPromises.lookup(host, { family: 4 })).address; }
      catch { throw bad(`Could not resolve "${host}" to an IPv4 address`, 422); }
    }
  }
  if (typeof ip !== "string" || !ip.trim()) {
    throw bad('Missing "ip" or "host". Send {"ip":"8.8.8.8"} or {"host":"google.com"}');
  }
  ip = ip.trim();
  if (isIP(ip) !== 4) throw bad('asn-info currently supports IPv4 only — pass an IPv4 address', 422);

  const originHost = `${reverseIpv4(ip)}.origin.asn.cymru.com`;
  let originTxt;
  try {
    const records = await dnsPromises.resolveTxt(originHost);
    originTxt = (records[0] || []).join("");
  } catch (err) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
      throw bad(`No ASN found for ${ip} — IP may be unrouted or reserved`, 422);
    }
    throw bad(`ASN lookup failed: ${err.message}`, 502);
  }
  // Format: "AS | prefix | CC | registry | allocation-date"
  const [asnRaw, prefix, country, registry, allocationDate] = originTxt.split("|").map(s => s.trim());
  const asn = asnRaw ? `AS${asnRaw.split(/\s+/)[0]}` : null;

  // Second query: AS owner name.
  let owner = null;
  if (asn) {
    try {
      const records = await dnsPromises.resolveTxt(`${asn}.asn.cymru.com`);
      const txt = (records[0] || []).join("");
      // "AS | CC | registry | date | name, CC"
      const parts = txt.split("|").map(s => s.trim());
      owner = parts[4] || null;
    } catch { /* leave owner null; primary record already returned */ }
  }

  return {
    ip,
    asn,
    owner,
    prefix: prefix || null,
    country: country || null,
    registry: registry || null,
    allocationDate: allocationDate || null,
    queriedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────  exports

export const NETWORK_TOOLS2 = [
  {
    route: "POST /api/cert-transparency",
    name: "Certificate transparency search",
    slug: "cert-transparency",
    category: "network",
    price: "$0.005",
    description:
      "Search public Certificate Transparency logs (via crt.sh) for every cert issued to a domain. Returns the cert list plus a deduped subdomain set extracted from the SANs — the fastest way to enumerate subdomains for a security audit. Free upstream, no key required.",
    tags: ["security", "ssl", "tls", "certificates", "subdomain-discovery", "audit"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Domain to search (also accepts host/hostname/url/email)" },
          includeExpired: { type: "boolean", description: "Include expired certs (default false)" },
          limit: { type: "integer", description: "Max certs to return (1–500, default 50)" },
        },
        required: ["domain"],
      },
      input: { domain: "example.com" },
      example: { domain: "example.com" },
      output: {
        example: {
          domain: "example.com",
          count: 2,
          truncated: false,
          subdomains: ["www.example.com"],
          certs: [
            {
              id: 1234567890,
              serial: "0a:1b:2c",
              issuer: "C=US, O=DigiCert Inc, CN=DigiCert TLS RSA SHA256 2020 CA1",
              commonName: "example.com",
              sans: ["example.com", "www.example.com"],
              notBefore: "2026-01-15T00:00:00",
              notAfter: "2027-02-14T23:59:59",
            },
          ],
          queriedAt: "2026-06-19T22:00:00.000Z",
        },
      },
    },
    handler: certTransparencyHandler,
  },
  {
    route: "POST /api/http-headers",
    name: "HTTP headers + security analysis",
    slug: "http-headers",
    category: "network",
    price: "$0.003",
    description:
      "Fetch a URL and return every response header plus a security analysis: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP/CORP/COEP. Scores 0–100 by presence, flags weak HSTS, and warns on Server/X-Powered-By identity leaks. SSRF-protected.",
    tags: ["security", "headers", "audit", "hsts", "csp", "compliance"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http(s) URL to probe" },
          method: { type: "string", description: "GET or HEAD (default GET)" },
        },
        required: ["url"],
      },
      input: { url: "https://example.com" },
      example: { url: "https://example.com" },
      output: {
        example: {
          url: "https://example.com/",
          finalUrl: "https://example.com/",
          status: 200,
          statusText: "OK",
          redirected: false,
          httpVersion: null,
          headers: { "content-type": "text/html; charset=UTF-8", "server": "ECAcc (nyd/D17C)" },
          security: {
            score: 0,
            findings: [{ header: "HSTS", present: false, value: null }],
            warnings: ["Server header leaks identity: ECAcc (nyd/D17C)"],
          },
          fetchedAt: "2026-06-19T22:00:00.000Z",
        },
      },
    },
    handler: httpHeadersHandler,
  },
  {
    route: "POST /api/tech-stack",
    name: "Tech stack detection",
    slug: "tech-stack",
    category: "network",
    price: "$0.005",
    description:
      "Detect the technology stack of a public website: CDN, web server, language/runtime, frontend framework (Next.js, Nuxt, SvelteKit, Remix, Astro, React, Vue, Angular), CMS (WordPress, Drupal, Ghost, Shopify, Wix, Squarespace, Webflow), analytics (GA, GTM, PostHog, Mixpanel, Segment, Hotjar, Plausible, Fathom), and payments (Stripe, PayPal). Signature-based; no third-party API.",
    tags: ["security", "audit", "research", "fingerprint"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http(s) URL to fingerprint" },
        },
        required: ["url"],
      },
      input: { url: "https://example.com" },
      example: { url: "https://example.com" },
      output: {
        example: {
          url: "https://example.com/",
          detected: [{ category: "server", name: "nginx" }],
          byCategory: { server: ["nginx"] },
          generator: null,
          server: "nginx",
          poweredBy: null,
          fetchedAt: "2026-06-19T22:00:00.000Z",
        },
      },
    },
    handler: techStackHandler,
  },
  {
    route: "POST /api/asn-info",
    name: "ASN + IP geolocation",
    slug: "asn-info",
    category: "network",
    price: "$0.003",
    description:
      "Look up the Autonomous System (ASN), prefix, country, registry, and allocation date for an IPv4 address — or for a hostname (which is resolved first). Uses Team Cymru's free DNS-based IP→ASN mapping; no HTTPS upstream, no auth, no rate-limit headaches.",
    tags: ["security", "network", "geolocation", "asn"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          ip: { type: "string", description: "IPv4 address to look up (mutually exclusive with host)" },
          host: { type: "string", description: "Hostname to resolve first (also accepts hostname/domain/url/email)" },
        },
      },
      input: { ip: "8.8.8.8" },
      example: { ip: "8.8.8.8" },
      output: {
        example: {
          ip: "8.8.8.8",
          asn: "AS15169",
          owner: "GOOGLE",
          prefix: "8.8.8.0/24",
          country: "US",
          registry: "arin",
          allocationDate: "1992-12-01",
          queriedAt: "2026-06-19T22:00:00.000Z",
        },
      },
    },
    handler: asnInfoHandler,
  },
];
