// domain-availability: is a domain name registered? Read from the registry
// itself over RDAP (RFC 9082/9083), the IETF's registration data protocol.
//
// Where to ask: IANA's RDAP bootstrap file (data.iana.org/rdap/dns.json,
// RFC 9224) names each TLD's authoritative RDAP base URL. It is read once a
// day (a failed refresh keeps the last map and asks again ten minutes later),
// and those base URLs are the ONLY hosts this tool sends a lookup to: no
// redirector, no redirect followed, every connection through the SSRF guard.
//
// What the registry says: a 200 with the domain object is registered; a 404
// carrying RDAP's own JSON (or a bare empty 404) is not registered
// (rdapSaysNotFound, shared with whois). Any other answer, a 404 web page
// included, is the registry being unavailable: a 502, never an answer, so it
// is not charged (a 4xx/5xx cancels settlement). A 429 is honored: that
// registry is not asked again until its Retry-After passes, and calls in that
// window answer a retryable 503 without reaching it.
//
// A name under a registered domain ("www.example.com") is not found at most
// registries; read as "not registered" it would tell a buyer the name is free.
// So a not-found name of three labels or more asks once for its parent: a
// parent that is someone's registration (it carries a registration date and
// is not marked a public suffix) answers registered null with the parent
// named; a second level the registry runs (co.uk) leaves the name not
// registered.
//
// Answers are kept briefly (CACHE_TTL_MS) so a buyer polling a name does not
// make the registry answer the same question each time; checkedAt is when the
// registry was read.
//
// The answer states registration only: the registry's record fields are not
// copied into it (`registrar` and `status` stay in the shape, reading null).
// Lookups share whois's per-registry pacing and daily ceiling
// (./rdap-registry-limits.js).
import { ssrfDispatcher, retryAfterSeconds, upstreamFailure } from "./fetch-guard.js";
import { parseRdapBootstrap, rdapSaysNotFound } from "./kit.js";
import { canonicalDnsName, internalNameReason } from "./dns-name-filter.js";
import { markEndsAtCeiling, capByCeiling, assertBeforeCeiling, ceilingPassed } from "../run-ceiling.js";
import { FETCH_UA } from "../user-agents.js";
import { createRegistryLimits, registryLimits, PACE_MS } from "./rdap-registry-limits.js";

export { PACE_MS };

export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_RETRY_MS = 10 * 60 * 1000;
export const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;
const LOOKUP_TIMEOUT_MS = 10_000;
const BODY_MAX_BYTES = 256 * 1024;
const DEFAULT_RETRY_AFTER_S = 30;
// A registry's Retry-After is honored up to this long: one caller's flood
// cannot close a registry to every buyer for a day.
const MAX_RETRY_AFTER_S = 300;
// Parents asked above a name that is not registered itself, from the
// registrable level down: enough for a registry-run second level (co.uk)
// and the registration under it.
const MAX_PARENT_LOOKUPS = 3;

export const AVAILABILITY_NOTE = "Read from the registry's RDAP service at checkedAt. Availability can change at any moment, and a name the registry reserves or blocks can read as not registered; registration itself happens at a registrar. The answer states registration only: registrar and status read null.";

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

/** The bootstrap entry for a name: the longest label suffix the file lists. */
export function rdapBaseFor(map, domain) {
  return rdapEntryFor(map, domain)?.base ?? null;
}
/** The bootstrap suffix that names a name's registry, and its base URL. */
export function rdapEntryFor(map, domain) {
  const labels = domain.split(".");
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const base = map.get(suffix);
    if (base) return { suffix, base };
  }
  return null;
}

/** The domain a caller sent, as the lower-case ASCII name RDAP is asked for;
 *  throws a 400 naming what is wrong. */
export function domainOf(input) {
  let raw = input?.domain ?? input?.name ?? input?.url ?? input?.hostname ?? "";
  if (typeof raw !== "string" || !raw.trim()) throw bad('Missing "domain". Send {"domain":"example.com"}.');
  raw = raw.trim();
  if (raw.length > 300) throw bad("The domain is longer than a domain name can be (253 characters).");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { raw = new URL(raw).hostname; } catch { throw bad(`Invalid domain "${raw.slice(0, 80)}". Send a name like example.com.`); }
  }
  const why = internalNameReason(raw);
  if (why) throw bad(why === "Invalid domain name" ? `Invalid domain "${raw.slice(0, 80)}". Send a name like example.com.` : why);
  const domain = canonicalDnsName(raw).replace(/\.$/, "").toLowerCase();
  if (domain.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw bad(`Invalid domain "${raw.slice(0, 80)}". Send a name like example.com.`);
  }
  return domain;
}

async function readBodyCapped(res, max) {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) { try { await res.body?.cancel(); } catch { /* closed */ } throw Object.assign(new Error("RDAP answer too large"), { statusCode: 502 }); }
  const reader = res.body?.getReader?.();
  if (!reader) return "";
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) { try { await reader.cancel(); } catch { /* closed */ } throw Object.assign(new Error("RDAP answer too large"), { statusCode: 502 }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the tool's lookup with its own caches. `fetchImpl` and `now` are the
 * test seams (a stub RDAP server); production uses the global fetch through
 * the SSRF dispatcher and the per-registry limits whois shares. A caller that
 * names `paceMs` or `dailyMax` gets limits of its own (tests).
 */
export function createDomainAvailability({ fetchImpl = null, now = () => Date.now(), bootstrapUrl = RDAP_BOOTSTRAP_URL, paceMs, dailyMax, limits = null } = {}) {
  const doFetch = fetchImpl || ((url, init) => fetch(url, { ...init, dispatcher: ssrfDispatcher }));
  const hostLimits = limits || (paceMs !== undefined || dailyMax !== undefined
    ? createRegistryLimits({ ...(paceMs !== undefined ? { paceMs } : {}), ...(dailyMax !== undefined ? { dailyMax } : {}), now })
    : registryLimits);
  let bootstrap = { at: 0, map: null, retryAt: 0 };
  const answers = new Map(); // domain -> { at, answer }
  const backoff = new Map(); // RDAP host -> epoch ms until which it is not asked

  async function bootstrapMap() {
    const t = now();
    const fresh = bootstrap.map && t - bootstrap.at < BOOTSTRAP_TTL_MS;
    if (fresh || (bootstrap.map && t < bootstrap.retryAt)) return bootstrap.map;
    if (!bootstrap.map && t < bootstrap.retryAt) return null;
    // Each call reads under its own ceiling (no shared in-flight read whose
    // wait another call's ceiling would bound); once a day, so a rare overlap.
    try {
      assertBeforeCeiling();
      const res = await doFetch(bootstrapUrl, { signal: AbortSignal.timeout(capByCeiling(LOOKUP_TIMEOUT_MS)), redirect: "error", headers: { Accept: "application/json", "User-Agent": FETCH_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const map = parseRdapBootstrap(JSON.parse(await readBodyCapped(res, 2 * 1024 * 1024)));
      if (!map.size) throw new Error("empty bootstrap");
      bootstrap = { at: now(), map, retryAt: 0 };
    } catch (err) {
      // A refresh the run's ceiling cut says nothing about IANA: the next call asks again.
      if (!(err?.ceilingCut || ceilingPassed())) {
        console.warn(`[domain-availability] RDAP bootstrap refresh failed (${err?.message}); ${bootstrap.map ? "keeping the last map" : "no map yet"}`);
        bootstrap = { ...bootstrap, retryAt: now() + BOOTSTRAP_RETRY_MS };
      }
    }
    return bootstrap.map;
  }

  /** One RDAP domain lookup: { found: true, data } | { found: false }. */
  async function rdapLookup(base, name) {
    const url = `${base}domain/${encodeURIComponent(name)}`;
    const host = new URL(url).host;
    const until = backoff.get(host) || 0;
    if (until > now()) {
      const retryAfter = Math.max(1, Math.ceil((until - now()) / 1000));
      throw upstreamFailure(429, { retryAfter, host });
    }
    // The day's ceiling, then a place in the host's pacing queue (a turn past
    // this run's ceiling is not waited for: the slug is marked endsAtCeiling).
    await hostLimits.admit(host);
    assertBeforeCeiling();
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(capByCeiling(LOOKUP_TIMEOUT_MS)), redirect: "manual", headers: { Accept: "application/rdap+json", "User-Agent": FETCH_UA } });
    } catch (err) {
      if (err?.statusCode) throw err;
      if (ceilingPassed()) throw Object.assign(new Error("The run's time limit passed before the registry answered, so the call was not completed"), { statusCode: 504, ceilingCut: true });
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw Object.assign(new Error(timedOut ? `The registry's RDAP service (${host}) did not answer in time; retry shortly` : `The registry's RDAP service (${host}) could not be reached; retry shortly`), { statusCode: 502, attribution: "upstream" });
    }
    if (res.status === 429) {
      const secs = Math.min(MAX_RETRY_AFTER_S, retryAfterSeconds(res.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_S);
      backoff.set(host, now() + secs * 1000);
      try { await res.body?.cancel(); } catch { /* closed */ }
      throw upstreamFailure(429, { retryAfter: secs, host });
    }
    if (res.status === 404) {
      const body = await readBodyCapped(res, 4096).catch(() => "x");
      if (rdapSaysNotFound(404, res.headers.get("content-type"), body)) return { found: false };
      throw Object.assign(new Error(`The registry's RDAP service (${host}) answered HTTP 404 without an RDAP body (registry server unavailable); retry later`), { statusCode: 502, upstreamStatus: 404, attribution: "upstream" });
    }
    if (res.status !== 200) {
      try { await res.body?.cancel(); } catch { /* closed */ }
      throw Object.assign(new Error(`The registry's RDAP service (${host}) answered HTTP ${res.status}; retry later`), { statusCode: 502, upstreamStatus: res.status, attribution: "upstream" });
    }
    let data;
    try { data = JSON.parse(await readBodyCapped(res, BODY_MAX_BYTES)); } catch (err) {
      if (err?.statusCode) throw err;
      throw Object.assign(new Error(`The registry's RDAP service (${host}) answered with a body that is not RDAP JSON; retry later`), { statusCode: 502, attribution: "upstream" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw Object.assign(new Error(`The registry's RDAP service (${host}) answered with a body that is not RDAP JSON; retry later`), { statusCode: 502, attribution: "upstream" });
    }
    return { found: true, data };
  }

  // A parent answers 200 at some registries without being anyone's
  // registration: a second level the registry runs (co.uk, com.au) is served
  // as a domain object with no registration date, and some mark it a public
  // suffix. Only a parent with a registration event, not so marked, holds the
  // name asked about.
  const isRegistration = (data) => {
    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.some((e) => e && e.eventAction === "registration")) return false;
    const remarks = [...(Array.isArray(data.remarks) ? data.remarks : []), ...(Array.isArray(data.notices) ? data.notices : [])];
    return !remarks.some((r) => /public suffix/i.test(String(r?.title ?? "")) || (Array.isArray(r?.description) && r.description.some((d) => /^this is a public suffix/i.test(String(d)))));
  };
  // The registry's own notices (its terms of use among them), passed through
  // as titles and https links only; their text is the registry's to show.
  const noticesOf = (data) => {
    const list = Array.isArray(data?.notices) ? data.notices : [];
    const out = [];
    for (const n of list.slice(0, 5)) {
      const links = (Array.isArray(n?.links) ? n.links : []).map((l) => (typeof l?.href === "string" ? l.href.trim() : "")).filter((h) => h.length <= 300 && /^https:\/\/[^\s]+$/i.test(h)).slice(0, 3);
      if (!links.length) continue;
      const title = typeof n?.title === "string" ? n.title.trim().slice(0, 120) : "";
      out.push({ ...(title ? { title } : {}), links });
    }
    return out.length ? { registryNotices: out } : {};
  };

  async function check(input) {
    const domain = domainOf(input);
    const t = now();
    const kept = answers.get(domain);
    if (kept && t - kept.at < CACHE_TTL_MS) return structuredClone(kept.answer);
    const map = await bootstrapMap();
    if (!map) {
      throw Object.assign(new Error("The registry list (IANA's RDAP bootstrap) could not be read just now; retry shortly"), { statusCode: 503, retryAfter: 30, attribution: "upstream" });
    }
    const entry = rdapEntryFor(map, domain);
    const base = entry?.base ?? null;
    if (!base) {
      const tld = domain.slice(domain.lastIndexOf(".") + 1);
      throw Object.assign(new Error(`The .${tld} registry lists no RDAP service in IANA's bootstrap file, so its registrations cannot be read here.`), { statusCode: 422, attribution: "caller" });
    }
    const checkedAt = new Date(now()).toISOString();
    let answer;
    const got = await rdapLookup(base, domain);
    if (got.found) {
      answer = { domain, registered: true, status: null, registrar: null, source: "RDAP", checkedAt, note: AVAILABILITY_NOTE, ...noticesOf(got.data) };
    } else {
      // The names above it, from the registrable level (one label under the
      // registry's suffix) down to its own parent: the first that is a
      // registration holds it. A registry-run second level (co.uk) answers
      // without being one, so the walk goes one level further.
      const labels = domain.split(".");
      const suffixLabels = entry.suffix.split(".").length;
      let holder = null;
      for (let keep = suffixLabels + 1, asked = 0; keep < labels.length && asked < MAX_PARENT_LOOKUPS; keep++, asked++) {
        const parent = labels.slice(labels.length - keep).join(".");
        const parentGot = await rdapLookup(base, parent);
        if (parentGot.found && isRegistration(parentGot.data)) { holder = { parent, data: parentGot.data }; break; }
        if (!parentGot.found) break; // nothing registered here, so nothing deeper is
      }
      answer = holder
        ? { domain, registered: null, status: null, registeredParent: holder.parent, source: "RDAP", checkedAt, note: `${domain} is a name under ${holder.parent}, which is registered; only ${holder.parent} itself is held at the registry. ${AVAILABILITY_NOTE}`, ...noticesOf(holder.data) }
        : { domain, registered: false, status: null, source: "RDAP", checkedAt, note: AVAILABILITY_NOTE };
    }
    if (answers.size >= CACHE_MAX) {
      for (const [k, v] of answers) { if (now() - v.at >= CACHE_TTL_MS) answers.delete(k); }
      while (answers.size >= CACHE_MAX) answers.delete(answers.keys().next().value);
    }
    answers.set(domain, { at: t, answer });
    return structuredClone(answer);
  }

  return { check, _state: () => ({ cached: answers.size, backoff: new Map(backoff), bootstrapAt: bootstrap.at }) };
}

const lookup = createDomainAvailability();

export const DOMAIN_AVAILABILITY_TOOLS = [
  {
    route: "POST /api/domain-availability",
    name: "Domain availability (RDAP)",
    slug: "domain-availability",
    aliases: ["domain-available", "domain-name-availability", "is-domain-registered"],
    category: "network",
    price: "$0.001",
    description: "Is a domain name registered? Asks the TLD's own registry over RDAP, the IETF registration data protocol (IANA's bootstrap names the registry): registered true, false, or null for a name under a registered domain (registeredParent names it), the registry's notices as links (registryNotices, its terms among them) when it gives them, and when the registry was read. The answer states registration only, so registrar and status read null. Lookups to each registry are paced and held to a daily limit. Availability can change at any moment; registration happens at a registrar.",
    tags: ["domain", "availability", "rdap", "registration", "available", "whois"],
    discovery: {
      bodyType: "json",
      input: { domain: "example.com" },
      inputSchema: {
        properties: { domain: { type: "string", maxLength: 300, description: "Domain name to check, e.g. example.com (a URL or an internationalized name is accepted)" } },
        required: ["domain"],
      },
      output: {
        example: {
          domain: "example.com",
          registered: true,
          status: null,
          registrar: null,
          source: "RDAP",
          checkedAt: "2026-11-22T12:00:00.000Z",
          note: AVAILABILITY_NOTE,
        },
      },
    },
    handler: (input) => lookup.check(input),
  },
];

const unmarked = markEndsAtCeiling(DOMAIN_AVAILABILITY_TOOLS, ["domain-availability"]);
if (unmarked.length) throw new Error(`domain-availability-kit: no tool for ${unmarked.join(", ")}`);
