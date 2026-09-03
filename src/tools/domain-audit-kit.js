// domain-audit-kit — Domain Security & Deliverability Audit. Hand over a domain
// and get one graded, actionable report: email authentication (SPF/DMARC/DKIM/
// MX), web security headers (HSTS/CSP/...), and the TLS certificate, plus (pro)
// the attack surface from Certificate Transparency logs, the tech stack, and
// domain registration. Every finding comes from a LIVE probe (deterministic,
// reproducible) - a chatbot guesses, this measures.
//
// The value is packaging + interpretation: the probes already exist as tools;
// this composes them, grades the whole domain, and synthesizes a prioritized
// remediation plan. The probes are free (only the synthesis touches OpenRouter).
// Settlement-safe (throws >=400 on failure), WALLET_ONLY, not cached. Gated on
// OPENROUTER_API_KEY for the synthesis (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { KIT } from "./kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { NETWORK_TOOLS } from "./network-kit.js";
import { NETWORK_TOOLS2 } from "./network-kit2.js";
import { promises as dnsPromises } from "node:dns";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const DOMAIN_AUDIT_MODELS = [SYNTH];

export const DOMAIN_AUDIT_TIERS = {
  "domain-audit": { price: "$0.60", maxUpstreamUsd: 0.35, pro: false, synthMaxTokens: 3500, words: "~1,200" },
  "domain-audit-pro": { price: "$0.85", maxUpstreamUsd: 0.5, pro: true, synthMaxTokens: 5000, words: "~1,900" },
};

const SYNTH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;

// Resolve a dependency handler across the kits that hold the probe tools,
// lazily (after all modules have loaded) to avoid any import-order surprise.
let _all = null;
const allTools = () => (_all ||= [...KIT, ...NETWORK_TOOLS, ...NETWORK_TOOLS2]);
function H(slug) {
  const t = allTools().find((x) => x.slug === slug);
  if (!t) throw bad(`domain-audit: missing dependency '${slug}'`, 500);
  return t.handler;
}
async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();

async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

/** Mailboxes a domain already publishes for reports: DMARC rua + ruf, plus any
 *  CAA iodef contact.
 *
 *  `reportingUris` is an OBJECT ({aggregate, failure}) - see parseDmarc in
 *  network-kit.js. The first version of this spread it as an ARRAY, so every
 *  domain publishing a rua or ruf (most of them) threw "is not iterable" and
 *  took the whole $0.60 report down with a 500. Nothing saw it for a day: the
 *  report composites are excluded from BOTH catalog sweeps, being metered and
 *  costly, and the line four above this one reads the same field correctly,
 *  which is how the two drifted apart. Exported so a test can hold the shape. */
export function reportMailboxesFrom(reportingUris, caa) {
  const ru = reportingUris;
  const fromDmarc = Array.isArray(ru) ? ru : [...(ru?.aggregate || []), ...(ru?.failure || [])];
  const fromCaa = (Array.isArray(caa) ? caa : []).filter((c) => c?.tag === "iodef").map((c) => c.value);
  return [...new Set([...fromDmarc, ...fromCaa].map((u) => String(u).replace(/^mailto:/i, "")).filter((u) => /@/.test(u)))];
}

export function normDomain(input) {
  let d = String(input?.domain ?? input?.url ?? input?.host ?? "").trim();
  if (!d) throw bad('"domain" is required, e.g. "example.com"');
  d = d.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || d.length > 253) throw bad(`"${d}" is not a valid domain name`);
  return d;
}

// Does the certificate cover this host? subject CN or a SAN, wildcard-aware
// (one label). Exported for tests.
export function certCoversHost(tls, domain) {
  const d = String(domain || "").toLowerCase();
  const names = [tls?.subject, ...(Array.isArray(tls?.altNames) ? tls.altNames : [])].filter(Boolean).map((n) => String(n).toLowerCase());
  if (!names.length) return null; // unknown - do not penalise what we did not see
  return names.some((n) => n === d || (n.startsWith("*.") && d.endsWith(n.slice(1)) && d.slice(0, -n.slice(1).length).indexOf(".") < 0 && d.length > n.length - 1));
}

// The DNS posture a "security & deliverability" buyer asks about and the
// core probes never fetched: CAA (who may issue certificates), MTA-STS and
// TLS-RPT (mail transport TLS enforcement + reporting), BIMI, and DNSSEC
// (validated through a DoH resolver's AD flag - node:dns cannot ask). Keyless,
// five small reads; a failed leg is "unknown", never "not configured".
const DNS_TIMEOUT_MS = 4000;
const dnsErrOk = (e) => e?.code === "ENOTFOUND" || e?.code === "ENODATA";
async function txtAt(name) {
  try {
    const recs = await Promise.race([dnsPromises.resolveTxt(name), new Promise((_, r) => setTimeout(() => r(new Error("DNS timeout")), DNS_TIMEOUT_MS))]);
    return { ok: true, records: (recs || []).map((chunks) => chunks.join("")) };
  } catch (e) { return { ok: dnsErrOk(e), records: [], error: e.code || e.message }; }
}
// Nameserver suffix -> the DNS host and what its panel can publish. A
// recommendation the reader cannot execute costs the report its credibility
// (Railway's DNS offers no CAA record type; the audit told a Railway-hosted
// domain to add one, 2026-08-28). `caa`/`dnssec` = false means the host is
// known not to offer it; null means unknown (say "check your DNS host").
// Exported for tests.
export const DNS_HOSTS = [
  { host: "Railway", ns: [".railway.app", ".railway.com"], caa: false, dnssec: false, platformCerts: true },
  { host: "Vercel", ns: [".vercel-dns.com"], caa: true, dnssec: false, platformCerts: true },
  { host: "Netlify", ns: [".nsone.net", ".netlify.com"], caa: true, dnssec: false, platformCerts: true },
  { host: "Cloudflare", ns: [".ns.cloudflare.com"], caa: true, dnssec: true, platformCerts: true },
  { host: "Amazon Route 53", ns: [".awsdns-"], caa: true, dnssec: true, platformCerts: false },
  { host: "Google Cloud DNS / Squarespace", ns: [".googledomains.com", ".google.com", ".squarespacedns.com"], caa: true, dnssec: true, platformCerts: false },
  { host: "GoDaddy", ns: [".domaincontrol.com"], caa: true, dnssec: true, platformCerts: false },
  { host: "Namecheap", ns: [".registrar-servers.com"], caa: true, dnssec: true, platformCerts: false },
  { host: "DigitalOcean", ns: [".digitalocean.com"], caa: true, dnssec: false, platformCerts: false },
  { host: "Hetzner", ns: [".hetzner.com", ".hetzner.de"], caa: true, dnssec: true, platformCerts: false },
  { host: "OVH", ns: [".ovh.net"], caa: true, dnssec: true, platformCerts: false },
  { host: "Gandi", ns: [".gandi.net"], caa: true, dnssec: true, platformCerts: false },
  { host: "Porkbun", ns: [".porkbun.com"], caa: true, dnssec: true, platformCerts: false },
  { host: "Hover", ns: [".hover.com"], caa: true, dnssec: false, platformCerts: false },
  { host: "Fly.io", ns: [".fly.io"], caa: null, dnssec: null, platformCerts: true },
  // Railway registers domains through name.com: the nameservers read name.com
  // but the owner edits DNS in Railway's panel, which offers no CAA record type
  // (and no DNSSEC). A domain managed at name.com directly can publish both.
  { host: "Name.com (Railway domain registrations use it)", ns: [".name.com"], caa: null, dnssec: null, platformCerts: false, note: "if this domain was bought through Railway, DNS is edited in Railway's panel, which offers no CAA record type and no DNSSEC; managed at name.com directly, both are available" },
];
export function dnsHostFor(nameservers) {
  const ns = (nameservers || []).map((h) => String(h || "").toLowerCase().replace(/\.$/, ""));
  for (const h of DNS_HOSTS) if (ns.some((n) => h.ns.some((suf) => n.includes(suf)))) return h;
  return null;
}
export async function probeDnsPosture(domain) {
  const nsR = await (async () => { try { const r = await Promise.race([dnsPromises.resolveNs(domain), new Promise((_, rj) => setTimeout(() => rj(new Error("DNS timeout")), DNS_TIMEOUT_MS))]); return { ok: true, records: r }; } catch (e) { return { ok: false, error: String(e?.code || e?.message || e) }; } })();
  const dnsHost = nsR.ok ? dnsHostFor(nsR.records) : null;
  const [caaR, sts, rpt, bimi, sec] = await Promise.all([
    (async () => { try { const r = await Promise.race([dnsPromises.resolveCaa(domain), new Promise((_, rj) => setTimeout(() => rj(new Error("DNS timeout")), DNS_TIMEOUT_MS))]); return { ok: true, records: r || [] }; } catch (e) { return { ok: dnsErrOk(e), records: [], error: e.code || e.message }; } })(),
    txtAt(`_mta-sts.${domain}`), txtAt(`_smtp._tls.${domain}`), txtAt(`default._bimi.${domain}`),
    (async () => {
      try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=SOA&do=1`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) });
        const j = await res.json();
        return { ok: true, ad: j?.AD === true, status: j?.Status };
      } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    })(),
  ]);
  const pick = (r, re) => (r.ok ? (r.records.find((x) => re.test(x)) || null) : null);
  return {
    caa: caaR.ok ? caaR.records.map((c) => ({ tag: c.issue ? "issue" : c.issuewild ? "issuewild" : c.iodef ? "iodef" : "other", value: c.issue || c.issuewild || c.iodef || JSON.stringify(c), critical: c.critical || 0 })) : null,
    caaError: caaR.ok ? null : caaR.error,
    mtaSts: pick(sts, /^v=STSv1/i), mtaStsError: sts.ok ? null : sts.error,
    tlsRpt: pick(rpt, /^v=TLSRPTv1/i), tlsRptError: rpt.ok ? null : rpt.error,
    bimi: pick(bimi, /^v=BIMI1/i), bimiError: bimi.ok ? null : bimi.error,
    dnssec: sec.ok ? sec.ad : null, dnssecError: sec.ok ? null : sec.error,
    nameservers: nsR.ok ? nsR.records.slice(0, 8) : [], nsError: nsR.ok ? null : nsR.error,
    dnsHost: dnsHost ? { name: dnsHost.host, caa: dnsHost.caa, dnssec: dnsHost.dnssec, platformCerts: dnsHost.platformCerts, ...(dnsHost.note ? { note: dnsHost.note } : {}) } : null,
  };
}
// Both hosts: the www twin of an apex (or the apex of a www) - whether it
// answers, where it redirects, and whether HSTS is consistent across the pair.
// A common misconfiguration that costs one extra request. Exported for tests.
export async function probeWwwPair(domain, hdrTool) {
  const twin = /^www\./i.test(domain) ? domain.replace(/^www\./i, "") : `www.${domain}`;
  try {
    const r = await Promise.race([hdrTool({ url: `https://${twin}` }), new Promise((_, rj) => setTimeout(() => rj(new Error("timeout")), PROBE_TIMEOUT_MS))]);
    const finalHost = (() => { try { return new URL(r.finalUrl || r.url || `https://${twin}`).hostname; } catch { return null; } })();
    return { twin, reachable: true, status: r.status ?? null, finalHost, redirectsToOther: !!finalHost && finalHost.toLowerCase() !== twin.toLowerCase(), hsts: !!(r.headers?.["strict-transport-security"] || (r.security?.findings || []).some((f) => f.header === "HSTS" && f.present)), error: null };
  } catch (e) {
    return { twin, reachable: false, status: null, finalHost: null, redirectsToOther: null, hsts: null, error: String(e?.message || e).slice(0, 120) };
  }
}

// Grade: email auth (40%) + web headers (35%) + TLS (25%).
// A certificate the chain does not trust, or one for a different host, is a
// broken TLS deployment however many days it has left - it used to score
// 100/100 on days alone (self-signed.badssl.com, wrong.host.badssl.com both
// graded perfect, measured 2026-08-26). Exported for tests.
export function tlsScoreOf(tls, domain = null) {
  if (!tls || tls.daysRemaining == null) return null;
  if (tls.chainTrusted === false) return 0;
  if (domain && certCoversHost(tls, domain) === false) return 0;
  const d = Number(tls.daysRemaining);
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (d > 30) return 100;
  if (d > 7) return 60;
  return 30;
}
function letterFor(n) { return n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F"; }

// The LIVE PROBE + GRADE stage, with no LLM: parallel probes (each non-fatal),
// per-dimension scores, the weighted composite and letter grade, and a
// deterministic FINGERPRINT of the security-relevant facts. Exported so the
// monitor scheduler can re-probe a subscribed domain for free on a cadence and
// only pay for a fresh synthesis when something actually changed; the paid
// handler below uses the SAME function, so the two can never grade differently.
export async function probeDomain(domain, { pro = false } = {}) {
  const emailH = H("email-deliverability"), tlsH = H("tls-cert"), hdrH = H("http-headers");
  const core = await Promise.all([
    settle(emailH({ domain }), PROBE_TIMEOUT_MS),
    settle(tlsH({ host: domain }), PROBE_TIMEOUT_MS),
    settle(hdrH({ url: `https://${domain}` }), PROBE_TIMEOUT_MS),
    settle(probeDnsPosture(domain), PROBE_TIMEOUT_MS),
  ]);
  const [emailR, tlsR, hdrR, dnsR] = core;
  const dnsx = dnsR.ok ? dnsR.data : null;
  const www = await probeWwwPair(domain, hdrH);
  let ct = null, tech = null, whois = null;
  if (pro) {
    const proTools = await Promise.all([
      settle(H("cert-transparency")({ domain, limit: 200 }), PROBE_TIMEOUT_MS),
      settle(H("tech-stack")({ url: `https://${domain}` }), PROBE_TIMEOUT_MS),
      settle(H("whois")({ domain }), PROBE_TIMEOUT_MS),
    ]);
    ct = proTools[0].ok ? proTools[0].data : null;
    tech = proTools[1].ok ? proTools[1].data : null;
    whois = proTools[2].ok ? proTools[2].data : null;
  }
  // If EVERY core probe failed, we cannot produce an audit (not charged).
  if (!emailR.ok && !tlsR.ok && !hdrR.ok) throw bad(`Could not reach "${domain}" on any probe (DNS, TLS, or HTTP). Confirm the domain is live. Not charged.`, 422);

  const email = emailR.ok ? emailR.data : null;
  const tls = tlsR.ok ? tlsR.data : null;
  const hdr = hdrR.ok ? hdrR.data : null;
  // A probe that failed (or returned no numeric score) is UNASSESSED, not a
  // zero - a network blip on the email probe must not silently print grade A
  // for a domain with broken email auth, nor drag it to F.
  const emailScore = typeof email?.score === "number" ? email.score : null;
  const headerScore = typeof hdr?.security?.score === "number" ? hdr.security.score : null;
  const tlsScore = tlsScoreOf(tls, domain);
  const dims = [], assessed = [];
  if (emailScore != null) { dims.push([0.40, emailScore]); assessed.push("email auth"); }
  if (headerScore != null) { dims.push([0.35, headerScore]); assessed.push("security headers"); }
  if (tlsScore != null) { dims.push([0.25, tlsScore]); assessed.push("TLS"); }
  if (!dims.length) throw bad(`Could not assess any security dimension for "${domain}" (all probes failed). Not charged.`, 422);
  const wsum = dims.reduce((a, [w]) => a + w, 0) || 1;
  const composite = Math.round(dims.reduce((a, [w, s]) => a + w * s, 0) / wsum);
  const grade = letterFor(composite);
  // The grade only covers dimensions we could measure - say so in the headline
  // so a missing dimension is visible, not buried in prose.
  const gradeCaveat = assessed.length === 3 ? "" : ` (assessed on ${assessed.join(", ")} only)`;

  // Security-relevant FACTS only (no timestamps, no free-text, no volatile
  // fields like days-remaining) so a re-probe of an unchanged domain yields the
  // same fingerprint. tls_days_remaining rides separately for expiry alerts.
  const signals = {
    grade, composite, assessed,
    spf: email ? (email.spf?.hasRecord ? `present:${email.spf.all || "?"}all:valid=${!!email.spf.valid}` : "missing") : null,
    dmarc: email ? (email.dmarc?.hasRecord ? `p=${email.dmarc.policy}:pct=${email.dmarc.percent}:valid=${!!email.dmarc.valid}` : "missing") : null,
    dkim: email ? (email.dkim?.found || []).map((d) => `${d.selector}:${d.bits}`).sort() : null,
    mx: email ? (email.mx?.count ?? 0) : null,
    dnssec: dnsx ? dnsx.dnssec : null,
    caa: dnsx ? (dnsx.caa || []).map((c) => `${c.tag}:${c.value}`).sort() : null,
    mtaSts: dnsx ? !!dnsx.mtaSts : null,
    tlsRpt: dnsx ? !!dnsx.tlsRpt : null,
    headers: hdr ? (hdr.security?.findings || []).filter((f) => f.present).map((f) => String(f.header || "").toLowerCase()).sort() : null,
    tls_issuer: tls?.issuer || null,
    tls_valid_to: tls?.validTo || null,
    tls_days_remaining: tls?.daysRemaining ?? null,
  };
  // Excluded from the fingerprint: days-remaining (volatile), and the TLS
  // issuer / valid-to pair - multi-cert CDNs rotate issuers and renew often,
  // which is not a security change; expiry is covered by tls_days_remaining
  // (the monitor's expiry alert) and by the TLS score folded into composite.
  const { tls_days_remaining: _d, tls_issuer: _i, tls_valid_to: _v, ...stable } = signals;
  const fingerprint = JSON.stringify(stable);

  return { domain, emailR, tlsR, hdrR, dnsR, dnsx, www, email, tls, hdr, ct, tech, whois, emailScore, headerScore, tlsScore, composite, grade, assessed, gradeCaveat, signals, fingerprint };
}

function makeDomainAuditHandlerInner(tierSlug) {
  const t = DOMAIN_AUDIT_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"domain": "example.com"}');
    const domain = normDomain(input);
    const user = safeUser(req);

    // 1) LIVE PROBES + GRADE (shared with the monitor scheduler's free re-probe).
    const { emailR, tlsR, hdrR, dnsR, dnsx, www, email, tls, hdr, ct, tech, whois, emailScore, headerScore, composite, grade, assessed, gradeCaveat } = await probeDomain(domain, { pro: t.pro });

    // 2) GROUNDING BLOCKS (the probe results are the only source of truth).
    const emailBlock = email
      ? `Score ${emailScore}/100 (${email.summary}). SPF: ${email.spf?.hasRecord ? `present (${email.spf.all || "?"}all, ${email.spf.lookupCountRecursive ?? email.spf.lookupCount} DNS lookups counted recursively through include/redirect (RFC 7208 limit 10; top-level ${email.spf.lookupCount}), valid=${email.spf.valid})` : "MISSING"}. DMARC: ${email.dmarc?.hasRecord ? `p=${email.dmarc.policy} at ${email.dmarc.percent}% (valid=${email.dmarc.valid}${email.dmarc.subdomainPolicy ? `; sp=${email.dmarc.subdomainPolicy}` : ""}${email.dmarc.alignment ? `; aspf=${email.dmarc.alignment.spf}, adkim=${email.dmarc.alignment.dkim}` : ""}${email.dmarc.reportingUris ? `; rua=${email.dmarc.reportingUris.aggregate?.length ? email.dmarc.reportingUris.aggregate.join(",") : "NONE"}; ruf=${email.dmarc.reportingUris.failure?.length ? email.dmarc.reportingUris.failure.join(",") : "none"}` : ""}${email.dmarc.failureOptions ? `; fo=${email.dmarc.failureOptions}` : ""})` : "MISSING"}. DKIM: ${email.dkim?.found?.length ? email.dkim.found.map((d) => `${d.selector} (${d.bits}-bit, valid=${d.valid})`).join(", ") : `none found (probed ${email.dkim?.probed?.length || 0} selectors: ${(email.dkim?.probed || []).join(", ")} - a selector outside that list would not be seen)`}. MX: ${email.mx?.count || 0} records${email.mx?.records?.length ? ` (${email.mx.records.slice(0, 8).join(", ")})` : ""}. Checks: ${(email.checks || []).map((c) => `${c.check}=${c.status}`).join(", ")}.`
      : `email-deliverability probe FAILED: ${emailR.error}`;
    const hdrBlock = hdr
      ? `Security-header score ${headerScore}/100. Findings: ${(hdr.security?.findings || []).map((f) => `${f.header}=${f.present ? `present${f.value ? ` [${String(f.value).replace(/\s+/g, " ").slice(0, 300)}]` : ""}` : "MISSING"}`).join(", ")}. Warnings: ${(hdr.security?.warnings || []).join("; ") || "none"}. HTTP status ${hdr.status}.`
      : `http-headers probe FAILED: ${hdrR.error}`;
    const tlsBlock = tls
      ? `Chain trusted: ${tls.chainTrusted === true ? "YES" : tls.chainTrusted === false ? `NO (${tls.authorizationError || "untrusted"}) - TLS scored 0` : "unknown"}; covers ${domain}: ${certCoversHost(tls, domain) === false ? "NO (hostname mismatch) - TLS scored 0" : certCoversHost(tls, domain) ? "yes" : "unknown"}. Issuer ${tls.issuer || "?"}, subject ${tls.subject || "?"}, valid to ${tls.validTo || "?"} (${tls.daysRemaining} days remaining), ${(tls.altNames || []).length} SANs${tls.protocol ? `, negotiated ${tls.protocol}${tls.cipher ? ` / ${tls.cipher}` : ""}` : ""}.`
      : `tls-cert probe FAILED: ${tlsR.error}`;
    const dnsBlock = dnsx
      ? `DNSSEC: ${dnsx.dnssec === true ? "validated (AD)" : dnsx.dnssec === false ? "NOT signed/validated" : `unknown (${dnsx.dnssecError || "resolver unreadable"})`}. CAA: ${dnsx.caa ? (dnsx.caa.length ? dnsx.caa.map((c) => `${c.tag} ${c.value}`).join("; ") : "none published (any CA may issue)") : `unknown (${dnsx.caaError})`}. MTA-STS: ${dnsx.mtaSts ? `present (${dnsx.mtaSts})` : dnsx.mtaStsError ? `unknown (${dnsx.mtaStsError})` : "not published"}. TLS-RPT: ${dnsx.tlsRpt ? `present (${dnsx.tlsRpt})` : dnsx.tlsRptError ? `unknown (${dnsx.tlsRptError})` : "not published"}. BIMI: ${dnsx.bimi ? "present" : dnsx.bimiError ? `unknown (${dnsx.bimiError})` : "not published"}.`
      : `DNS posture probe FAILED: ${dnsR.error} - DNSSEC/CAA/MTA-STS/TLS-RPT/BIMI were NOT checked.`;
    const hostBlock = dnsx
      ? `Nameservers: ${dnsx.nameservers?.length ? dnsx.nameservers.join(", ") : `unknown (${dnsx.nsError || "no answer"})`}. DNS host: ${dnsx.dnsHost ? `${dnsx.dnsHost.name} - CAA records ${dnsx.dnsHost.caa === false ? "NOT OFFERED by this host's DNS panel" : dnsx.dnsHost.caa ? "supported" : "support unknown"}; DNSSEC ${dnsx.dnsHost.dnssec === false ? "NOT OFFERED by this host" : dnsx.dnsHost.dnssec ? "supported" : "support unknown"}${dnsx.dnsHost.platformCerts ? "; TLS certificates are issued and rotated by the hosting platform (it may switch CA, e.g. Let's Encrypt <-> Google Trust Services)" : ""}${dnsx.dnsHost.note ? `; NOTE: ${dnsx.dnsHost.note}` : ""}` : "not recognised (CAA/DNSSEC support unknown - the reader must check their DNS host's panel)"}.`
      : "Nameservers / DNS host: not checked (DNS posture probe failed).";
    const wwwBlock = www
      ? (www.reachable ? `${www.twin}: reachable (HTTP ${www.status ?? "?"}), ${www.redirectsToOther ? `redirects to ${www.finalHost}` : "serves its own response (no redirect to the other host)"}, HSTS ${www.hsts ? "present" : "ABSENT"} there${hdr ? ` vs ${(hdr.security?.findings || []).some((f) => f.header === "HSTS" && f.present) ? "present" : "absent"} on ${domain}` : ""}.` : `${www.twin}: NOT reachable (${www.error}) - if people type it, they get an error.`)
      : "www/apex twin: not checked.";
    // `reportingUris` is an OBJECT ({aggregate, failure}) - see parseDmarc in
    // network-kit.js. Spreading it as an array threw "is not iterable" on every
    // domain that publishes a rua or ruf, which is most of them, and took the
    // whole report down with a 500 (found 2026-08-29; the composite is excluded
    // from both catalog sweeps, so nothing could see it). Line 268 above reads
    // the same field correctly, which is how the two drifted apart.
    const knownMailboxes = reportMailboxesFrom(email?.dmarc?.reportingUris, dnsx?.caa);
    const mailboxBlock = `Addresses this domain already publishes for reports: ${knownMailboxes.length ? knownMailboxes.join(", ") : "NONE (no rua/ruf/iodef published)"}. Mail is ${email?.mx?.count ? `received at ${email.mx.provider || "the MX hosts above"}` : "not receivable (no MX)"}.`;
    const proBlock = t.pro ? [
      ct ? `CERTIFICATE TRANSPARENCY: ${ct.count ?? (ct.certs?.length || 0)} certificates read${ct.truncated ? " (MORE exist - the log was truncated at the read limit)" : ""}, ${(ct.subdomains || []).length} distinct subdomains among them. Subdomains: ${(ct.subdomains || ct.names || []).slice(0, 40).join(", ") || "(none parsed)"}${(ct.subdomains || []).length > 40 ? ` (+${(ct.subdomains || []).length - 40} more)` : ""}.` : "CT probe unavailable.",
      tech ? `TECH STACK: ${(tech.technologies || tech.stack || tech.detected || []).map((x) => (typeof x === "string" ? x : x.name || x.technology)).filter(Boolean).slice(0, 40).join(", ") || "(none detected)"}.` : "Tech-stack probe unavailable.",
      whois ? `REGISTRATION: registrar ${whois.registrar || "?"}, created ${whois.created || whois.creationDate || "?"}, expires ${whois.expires || whois.expiryDate || "?"}; status ${(Array.isArray(whois.status) ? whois.status : [whois.status]).filter(Boolean).join(", ") || "unknown"} (transfer lock = clientTransferProhibited); nameservers ${(whois.nameservers || []).slice(0, 6).join(", ") || "unknown"}; DNSSEC per RDAP ${whois.dnssec == null ? "unknown" : whois.dnssec ? "signed" : "unsigned"}.` : "WHOIS probe unavailable.",
    ].join("\n") : "";

    // 3) SYNTHESIZE - grounded, graded, actionable.
    const synthPrompt = `You are a security analyst writing a DOMAIN SECURITY & DELIVERABILITY AUDIT for ${domain} that will be SOLD to a paying customer. Every statement must come from the LIVE PROBE RESULTS below - do not invent a finding, header, or record that is not in the data.

The overall grade is ${grade} (composite ${composite}/100)${gradeCaveat}. Write a clear, well-structured report of up to ${t.words} words with these sections:
- OVERALL GRADE: state the letter grade ${grade} and composite ${composite}/100, a one-paragraph bottom line, AND if the grade covers only some dimensions (${assessed.join(", ")}) say so plainly - the grade does not cover any probe that could not be completed.
- EMAIL AUTHENTICATION: SPF, DMARC, DKIM, and MX - what is configured, what is missing or weak, and specifically why it affects whether mail lands in the inbox vs spam.
- WEB SECURITY HEADERS: which security headers are present or missing (HSTS, CSP, X-Frame-Options, etc.) and the risk each missing one creates.
- TLS CERTIFICATE: issuer, expiry, and days remaining - flag clearly if it is expiring soon.${t.pro ? "\n- ATTACK SURFACE & STACK: notable subdomains from Certificate Transparency, the detected tech stack, and domain registration." : ""}
- PRIORITIZED FIXES: a NUMBERED, actionable remediation list, most impactful first. Name the exact record or header to add and a concrete example value where you can (e.g. the DMARC record to publish). Be specific and practical.

Rules for the fixes, each learned from a real report:
1. MAILBOXES: never present an address as ready to receive reports unless it appears under "Addresses this domain already publishes". Otherwise write the rua/ruf/iodef step as "create a mailbox first (for example dmarc@${domain}), then publish", never as a finished record with an address you invented. A DMARC rua that points at a dead mailbox silently swallows every report.
2. FEASIBILITY: if the DNS host is marked NOT OFFERED for CAA or DNSSEC, do not recommend adding it; say "your DNS host (${dnsx?.dnsHost?.name || "the detected host"}) does not offer this record type" and, at most, note that moving DNS to a host that does is the only way. If support is unknown, say the reader must check their DNS host's panel first.
3. CAA WITH PLATFORM CERTIFICATES: when the TLS certificate is issued by a hosting platform's automation, a CAA record naming only today's CA breaks renewal the day the platform rotates CA. Recommend the full set the platform uses (for Let's Encrypt and Google Trust Services: both "letsencrypt.org" and "pki.goog"), or say to skip CAA until the platform documents its CAs.
4. CROSS-ORIGIN HEADERS (COOP, CORP, COEP) are advisory: they matter only for a site that needs cross-origin isolation, COEP require-corp breaks third-party assets, and they are not in the score. Mention them once as optional, never as missing headers to fix.
5. CSP: distinguish a strict policy (nonces/hashes, no 'unsafe-inline') from a permissive one; a permissive CSP is a partial fix, not a pass.
6. The Server header is informational (the platform is visible from DNS anyway and an edge-injected header cannot be removed by the app); X-Powered-By is a real, removable disclosure.
7. Escalate safely: DMARC p=none with reporting first then quarantine/reject; HSTS with a short max-age first; CSP report-only first.
8. Check both hosts: use the www/apex twin result - a twin that does not redirect, or lacks HSTS while the other has it, is a finding.

Do NOT write a sources section. Ground every claim in the probe data; where a probe failed, say the check could not be completed rather than guessing.

=== EMAIL AUTH PROBE ===\n${emailBlock}
=== WEB SECURITY HEADERS PROBE ===\n${hdrBlock}
=== TLS CERTIFICATE PROBE ===\n${tlsBlock}
=== DNS POSTURE (DNSSEC, CAA, MTA-STS, TLS-RPT, BIMI) ===\n${dnsBlock}
=== NAMESERVERS / DNS HOST (what the reader CAN publish) ===\n${hostBlock}
=== WWW / APEX TWIN ===\n${wwwBlock}
=== REPORT MAILBOXES ===\n${mailboxBlock}
NOTE: a gap in this material is never a finding about the domain - a probe marked FAILED or unknown was not checked here; say so instead of "not configured".${t.pro ? `\n=== ATTACK SURFACE / STACK / REGISTRATION ===\n${proBlock}` : ""}`;

    let spent = 0;
    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Domain audit synthesis produced nothing - not charged", 502);
    const header = `# Domain Security Audit: ${domain}\n\n**Overall grade: ${grade}** (${composite}/100)${gradeCaveat}\n`;
    const report = `${header}\n${prose}`;

    // 4) DOWNLOADABLE DATA APPENDIX.
    const tables = [];
    if (email?.checks?.length) tables.push({
      name: "email-checks", label: "Email authentication checks",
      columns: ["Check", "Status", "Detail"],
      rows: email.checks.map((c) => [String(c.check || ""), String(c.status || ""), String(c.detail || "")]),
    });
    if (hdr?.security?.findings?.length) tables.push({
      name: "security-headers", label: "Web security headers",
      columns: ["Header", "Present", "Value"],
      rows: hdr.security.findings.map((f) => [String(f.header || ""), f.present ? "yes" : "no", String(f.value ?? "")]),
    });
    if (t.pro && ct) {
      const subs = ct.subdomains || ct.names || [];
      if (subs.length) tables.push({ name: "subdomains", label: "Subdomains (Certificate Transparency)", columns: ["Subdomain"], rows: subs.slice(0, 500).map((s) => [String(s)]) });
    }

    const meta = {
      tier: tierSlug, domain, grade, composite, assessed,
      email_score: emailScore,
      header_score: headerScore,
      tls_days_remaining: tls?.daysRemaining ?? null,
      dns_host: dnsx?.dnsHost?.name || null,
      mx_provider: email?.mx?.provider || null,
      www: www ? { twin: www.twin, reachable: www.reachable, redirectsToOther: www.redirectsToOther, hsts: www.hsts } : null,
      probes: { email: emailR.ok, tls: tlsR.ok, headers: hdrR.ok, ...(t.pro ? { certTransparency: !!ct, techStack: !!tech, whois: !!whois } : {}) },
      synthesis_model: SYNTH,
    };
    const out = { report, domain, grade, composite, sources: [], tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { emailBlock, hdrBlock, tlsBlock, proBlock, hostBlock, wwwBlock, mailboxBlock };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(DOMAIN_AUDIT_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["domain"],
  properties: {
    domain: { type: "string", description: "The domain to audit, e.g. example.com (also accepts a URL or host)." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Domain Security Audit: example.com\n\n**Overall grade: B** (82/100)\n\n## Overall grade\n...",
  domain: "example.com", grade: "B", composite: 82,
  sources: [],
  tables: [{ name: "email-checks", label: "Email authentication checks", columns: ["Check", "Status", "Detail"], rows: [["spf", "pass", "SPF record present, 1 DNS lookup, ~all qualifier"]] }],
  meta: { tier: "domain-audit", domain: "example.com", grade: "B", composite: 82, email_score: 90, header_score: 70, tls_days_remaining: 204, synthesis_model: "anthropic/claude-opus-5" },
};

export const DOMAIN_AUDIT_TOOLS = [
  {
    route: "POST /v1/domain-audit", name: "Domain security & deliverability audit (graded)", slug: "domain-audit", category: "llm", price: DOMAIN_AUDIT_TIERS["domain-audit"].price,
    description: "Hand over a domain and get one graded security & email-deliverability audit: SPF, DMARC, DKIM and MX (why your mail lands in spam), the web security headers, and the TLS certificate - every finding from a live probe, with an overall letter grade, a downloadable checks appendix, and a prioritized, specific list of fixes. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["security", "domain", "email", "deliverability", "spf", "dmarc", "dkim", "tls", "headers", "audit", "premium", "agent"],
    discovery: { bodyType: "json", input: { domain: "example.com" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeDomainAuditHandler("domain-audit"),
  },
  {
    route: "POST /v1/domain-audit/pro", name: "Domain security audit - PRO (attack surface + stack)", slug: "domain-audit-pro", category: "llm", price: DOMAIN_AUDIT_TIERS["domain-audit-pro"].price,
    description: "The deeper tier: everything in the standard audit plus the attack surface from Certificate Transparency logs (subdomains), the detected tech stack, and domain registration, in a longer graded report with a fuller remediation plan. USDC or card (Stripe). Not cached.",
    tags: ["security", "domain", "email", "deliverability", "attack-surface", "subdomains", "tls", "audit", "premium", "agent"],
    discovery: { bodyType: "json", input: { domain: "example.com" }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "domain-audit-pro" } } } },
    handler: makeDomainAuditHandler("domain-audit-pro"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeDomainAuditHandler(tierSlug) {
  const run = makeDomainAuditHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(DOMAIN_AUDIT_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
