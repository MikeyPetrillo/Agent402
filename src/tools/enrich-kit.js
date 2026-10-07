// Entity/enrichment kit — who-is-this-company/person/site lookups for agents:
// GLEIF legal-entity records (LEI), Wikidata entity facts, Gravatar existence
// signal, GitHub repository enrichment, and site favicon capture.
//
// Every upstream is KEYLESS — no new required env vars. github-repo optionally
// sends `Authorization: Bearer ${GITHUB_TOKEN}` when that env var is set (lifts
// the shared 60 req/hr/IP ceiling to 5k/hr); env-gated no-op if unset, never
// required. All five tools reach the network and live in WALLET_ONLY_SLUGS.
//
// SSRF: favicon-grab takes a caller URL and rides safeFetch/assertPublicUrl
// end-to-end (page fetch AND the icon fetch derived from the page's HTML).
// The other tools hit fixed hosts but still ride the guarded dispatcher by
// convention. github-repo path segments are validated before interpolation:
// owner gets GitHub's real username charset (no dots at all), repo keeps dots
// (.github, repo.js are legit) but "."/".." and any ".." substring are
// rejected — otherwise owner=".." would URL-normalize /repos/../user into an
// arbitrary single-segment GitHub API endpoint spent on OUR token budget.
//
// Covered by scripts/test-enrich-kit.js (offline validation; live upstream
// checks opt-in via ENRICH_LIVE_TEST=1).

import { createHash } from "node:crypto";
import { ssrfDispatcher, safeFetch } from "./fetch-guard.js";

const TIMEOUT_MS = 12_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Small JSON GET against a fixed keyless upstream. Hosts are hardcoded by the
// handlers (except favicon-grab, which uses safeFetch instead), so this is not
// an SSRF surface, but every fetch still rides the guarded dispatcher.
// 404 passes through as { status: 404 } so handlers can return structured
// misses instead of errors.
async function getJson(url, upstream, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Agent402/1.0 (+https://agent402.tools)", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher: ssrfDispatcher,
    });
  } catch {
    throw bad(`${upstream} did not respond - try again shortly`, 504);
  }
  if (res.status === 429) throw bad(`${upstream} rate limit reached - retry shortly`, 503);
  if (res.status === 403) {
    // GitHub reports an exhausted per-IP quota as 403 with a zeroed remaining
    // header — that's capacity, not authorization; surface as retryable 503.
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      throw bad(`${upstream} rate limit reached - retry shortly`, 503);
    }
    throw bad(`${upstream} refused the request (HTTP 403)`, 502);
  }
  if (!res.ok && res.status !== 404) throw bad(`${upstream} error (HTTP ${res.status})`, 502);
  let data = null;
  try { data = await res.json(); } catch {
    if (res.status !== 404) throw bad(`${upstream} returned non-JSON`, 502);
  }
  return { status: res.status, data };
}

// ============================================================================
// lei-lookup — GLEIF (Global Legal Entity Identifier Foundation) registry.
// ============================================================================
const LEI_RE = /^[A-Z0-9]{20}$/;
const GLEIF = "https://api.gleif.org/api/v1";

function leiRecordSummary(rec) {
  const a = rec?.attributes || {};
  const e = a.entity || {};
  const r = a.registration || {};
  const addr = (x) => (x ? { city: x.city ?? null, region: x.region ?? null, country: x.country ?? null } : null);
  return {
    lei: a.lei ?? null,
    legalName: e.legalName?.name ?? null,
    otherNames: (e.otherNames || []).map((n) => n.name).filter(Boolean).slice(0, 10),
    jurisdiction: e.jurisdiction ?? null,
    category: e.category ?? null,
    legalForm: e.legalForm?.id ?? null,
    entityStatus: e.status ?? null,
    legalAddress: addr(e.legalAddress),
    headquartersAddress: addr(e.headquartersAddress),
    registration: {
      status: r.status ?? null,
      initialDate: r.initialRegistrationDate ?? null,
      lastUpdated: r.lastUpdateDate ?? null,
      nextRenewal: r.nextRenewalDate ?? null,
      corroborationLevel: r.corroborationLevel ?? null,
    },
  };
}

// Direct/ultimate parent — 404 from GLEIF means "no parent reported (or a
// reporting exception)", a normal answer, not an error.
async function leiParent(lei, which) {
  const { status, data } = await getJson(`${GLEIF}/lei-records/${lei}/${which}`, "GLEIF");
  if (status === 404 || !data?.data) return null;
  const a = data.data.attributes || {};
  return { lei: a.lei ?? null, legalName: a.entity?.legalName?.name ?? null };
}

// ============================================================================
// wikidata-entity — Wikidata wbgetentities / wbsearchentities.
// ============================================================================
const WD_API = "https://www.wikidata.org/w/api.php";
const QID_RE = /^Q\d{1,10}$/;

// Curated property map — the enrichment facts agents actually ask for.
// Item-valued claims get their labels resolved in one batched follow-up call.
const WD_PROPS = {
  P31: "instanceOf",
  P571: "inception",
  P17: "country",
  P159: "headquartersLocation",
  P452: "industry",
  P112: "foundedBy",
  P169: "chiefExecutiveOfficer",
  P488: "chairperson",
  P1128: "employees",
  P2139: "totalRevenue",
  P856: "officialWebsite",
  P1278: "lei",
  P249: "tickerSymbol",
  P414: "stockExchange",
  P946: "isin",
  P154: "logoImage",
  P18: "image",
  // person-shaped facts
  P569: "dateOfBirth",
  P570: "dateOfDeath",
  P27: "citizenship",
  P106: "occupation",
  P108: "employer",
};
const WD_MAX_VALUES_PER_PROP = 8;

// Render a mainsnak datavalue into plain JSON. Item references come out as
// { id } and get a label attached later.
function renderSnak(snak) {
  if (!snak || snak.snaktype !== "value") return null;
  const dv = snak.datavalue;
  if (!dv) return null;
  switch (dv.type) {
    case "wikibase-entityid":
      return { id: dv.value.id };
    case "time":
      return String(dv.value.time || "").replace(/^\+/, "");
    case "quantity":
      return String(dv.value.amount || "").replace(/^\+/, "");
    case "monolingualtext":
      return dv.value.text ?? null;
    case "globecoordinate":
      return { lat: dv.value.latitude, lon: dv.value.longitude };
    case "string":
      // commonsMedia filenames become a fetchable URL.
      if (snak.datatype === "commonsMedia") {
        return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(dv.value)}`;
      }
      return dv.value;
    default:
      return null;
  }
}

// ============================================================================
// gravatar-check — MD5/SHA-256 the email (pure CPU), then one small probe.
// ============================================================================
const HASH_RE = /^[a-f0-9]{32}$|^[a-f0-9]{64}$/;

async function gravatarProbe(url, upstream, accept = "*/*") {
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: accept, "User-Agent": "Agent402/1.0 (+https://agent402.tools)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher: ssrfDispatcher,
    });
  } catch {
    throw bad(`${upstream} did not respond - try again shortly`, 504);
  }
  if (res.status === 429) throw bad(`${upstream} rate limit reached - retry shortly`, 503);
  return res;
}

// ============================================================================
// github-repo — GitHub REST v3, keyless (optional GITHUB_TOKEN lifts limits).
// ============================================================================
// Owner follows GitHub's actual username/org rule: alphanumeric + hyphens,
// can't start with a hyphen, max 39 chars — critically, NO dots, so "." / ".."
// can never build a path-traversing /repos/../<x> URL.
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// Repo names legitimately contain dots (e.g. ".github", "repo.js"), so dots
// stay in the charset — dot-only and ".."-bearing names are rejected in the
// handler instead.
const GH_REPO_RE = /^[A-Za-z0-9._-]+$/;

function ghHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Optional env-gated enhancement: 60 req/hr/IP keyless → 5k/hr with a token.
  // Never required; absence changes nothing but the rate limit.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// ============================================================================
// favicon-grab — declared-icon discovery + SSRF-guarded fetch.
// ============================================================================
const PAGE_MAX_BYTES = 1024 * 1024; // HTML page read cap
const ICON_MAX_BYTES = 1024 * 1024; // icon fetch cap (413 past this)
const ICON_DATAURI_MAX = 256 * 1024; // inline as data URI only up to here

function parseDeclaredIcons(html, baseUrl) {
  const icons = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
      return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
    };
    const rel = (attr("rel") || "").toLowerCase();
    // rel is a space-separated token list — match the icon-bearing rels.
    const tokens = rel.split(/\s+/);
    if (!tokens.includes("icon") && !tokens.includes("apple-touch-icon") && !tokens.includes("apple-touch-icon-precomposed") && !tokens.includes("mask-icon")) continue;
    const href = attr("href");
    if (!href) continue;
    let resolved;
    try { resolved = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https?:/.test(resolved)) continue;
    icons.push({
      href: resolved,
      rel,
      sizes: (attr("sizes") || null),
      type: (attr("type") || null),
      // Safari mask icons are monochrome outlines — usable, but only when
      // nothing better is declared.
      mask: tokens.includes("mask-icon") && !tokens.includes("icon"),
    });
    if (icons.length >= 20) break;
  }
  return icons;
}

// Deterministic pick: real icons (rel icon / apple-touch-icon) beat monochrome
// mask icons; within a class the largest declared pixel area wins
// (unspecified/any = 0); ties break by document order.
function pickIcon(icons) {
  const byArea = (list) => {
    let best = null, bestArea = -1;
    for (const icon of list) {
      const m = (icon.sizes || "").match(/(\d+)x(\d+)/i);
      const area = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
      if (area > bestArea) { best = icon; bestArea = area; }
    }
    return best;
  };
  return byArea(icons.filter((i) => !i.mask)) || byArea(icons);
}

async function fetchIcon(url) {
  const { finalUrl, buffer, contentType } = await safeFetch(url, { binary: true, maxBytes: ICON_MAX_BYTES, headers: { Accept: "image/*,*/*" } });
  if (!buffer.length) throw bad("Icon URL returned an empty body", 422);
  return { finalUrl, buffer, contentType: (contentType || "image/x-icon").split(";")[0].trim() };
}

// ============================================================================
export const ENRICH_TOOLS = [
  // ===========================================================================
  // lei-lookup — GLEIF legal-entity registry: LEI record or fulltext search.
  // ===========================================================================
  {
    route: "POST /api/lei-lookup",
    name: "Legal entity (LEI) lookup",
    slug: "lei-lookup",
    category: "data",
    price: "$0.005",
    description:
      "Look up a legal entity in the official GLEIF registry. Pass a 20-character LEI for the full record - legal name, jurisdiction, legal form, addresses, registration status, and the reported direct + ultimate parent entities - or pass a company name to fulltext-search the registry and get ranked candidate LEIs. Unknown LEIs return {found:false}; parents that aren't reported return null. Official registry data, keyless.",
    tags: ["data", "lei", "gleif", "legal-entity", "company", "enrichment", "kyc"],
    discovery: {
      bodyType: "json",
      input: { lei: "HWUPKR0MPOU8FGXBT394" },
      inputSchema: {
        properties: {
          lei: { type: "string", description: "20-character alphanumeric Legal Entity Identifier (exact record lookup)." },
          name: { type: "string", description: "Company name to fulltext-search instead (ranked candidate list). Provide lei OR name." },
        },
      },
      output: {
        example: {
          found: true,
          record: {
            lei: "HWUPKR0MPOU8FGXBT394",
            legalName: "APPLE INC.",
            jurisdiction: "US-CA",
            entityStatus: "ACTIVE",
            legalAddress: { city: "Cupertino", region: "US-CA", country: "US" },
            registration: { status: "ISSUED", nextRenewal: "2026-10-13T00:31:58Z" },
          },
          parents: { direct: null, ultimate: null },
          source: "api.gleif.org",
        },
      },
    },
    handler: async (i) => {
      const lei = typeof i.lei === "string" ? i.lei.trim().toUpperCase() : "";
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (lei) {
        if (!LEI_RE.test(lei)) throw bad(`"lei" must be a 20-character alphanumeric LEI, e.g. HWUPKR0MPOU8FGXBT394`);
        const { status, data } = await getJson(`${GLEIF}/lei-records/${lei}`, "GLEIF");
        if (status === 404 || !data?.data) {
          return { found: false, lei, record: null, note: "No record for this LEI in the GLEIF registry.", source: "api.gleif.org" };
        }
        const [direct, ultimate] = await Promise.all([
          leiParent(lei, "direct-parent"),
          leiParent(lei, "ultimate-parent"),
        ]);
        return { found: true, record: leiRecordSummary(data.data), parents: { direct, ultimate }, source: "api.gleif.org" };
      }
      if (!name) throw bad(`Provide "lei" (20-char identifier) or "name" (company name to search)`);
      if (name.length > 200) throw bad(`"name" is capped at 200 characters`);
      const { data } = await getJson(`${GLEIF}/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(name)}&page%5Bsize%5D=10`, "GLEIF");
      const matches = (Array.isArray(data?.data) ? data.data : []).map((rec) => {
        const a = rec.attributes || {};
        return {
          lei: a.lei ?? null,
          legalName: a.entity?.legalName?.name ?? null,
          jurisdiction: a.entity?.jurisdiction ?? null,
          entityStatus: a.entity?.status ?? null,
          registrationStatus: a.registration?.status ?? null,
        };
      });
      return {
        found: matches.length > 0,
        query: name,
        matches,
        note: matches.length ? "Pass a candidate's lei back for the full record + parents." : "No registry match for this name.",
        source: "api.gleif.org",
      };
    },
  },

  // ===========================================================================
  // wikidata-entity — entity facts by Q-id, or ranked name search.
  // ===========================================================================
  {
    route: "POST /api/wikidata-entity",
    name: "Wikidata entity facts",
    slug: "wikidata-entity",
    category: "data",
    price: "$0.005",
    description:
      "Company/person/organization facts from Wikidata. Pass an entity id (e.g. Q312 for Apple Inc.) for the enrichment record - label, description, aliases, and a curated fact set (inception, HQ location, country, industry, founders, CEO, employees, revenue, official website, LEI, ticker + exchange, ISIN, logo; for people: birth/death dates, citizenship, occupation) with item references resolved to human-readable labels. Or pass a name to search: ambiguous names return ranked candidate matches in Wikidata's stable order. Keyless.",
    tags: ["data", "wikidata", "entity", "company", "person", "enrichment", "knowledge-graph"],
    discovery: {
      bodyType: "json",
      input: { id: "Q312" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Wikidata entity id, e.g. Q312 (exact entity lookup)." },
          name: { type: "string", description: "Entity name to search instead (ranked candidate list). Provide id OR name." },
        },
      },
      output: {
        example: {
          found: true,
          id: "Q312",
          label: "Apple Inc.",
          description: "American multinational technology company",
          aliases: ["Apple", "Apple Computer, Inc."],
          facts: {
            inception: ["1976-04-01T00:00:00Z"],
            headquartersLocation: [{ id: "Q3070754", label: "Apple Park" }],
            officialWebsite: ["https://www.apple.com/"],
            tickerSymbol: ["AAPL"],
            lei: ["HWUPKR0MPOU8FGXBT394"],
          },
          statementCount: 300,
          source: "wikidata.org",
        },
      },
    },
    handler: async (i) => {
      const id = typeof i.id === "string" ? i.id.trim().toUpperCase() : "";
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (id) {
        if (!QID_RE.test(id)) throw bad(`"id" must be a Wikidata entity id like Q312`);
        const { data } = await getJson(
          `${WD_API}?action=wbgetentities&ids=${id}&props=labels%7Cdescriptions%7Caliases%7Cclaims&languages=en&format=json&origin=*`,
          "Wikidata"
        );
        const ent = data?.entities?.[id];
        if (!ent || ent.missing !== undefined) {
          return { found: false, id, note: "No Wikidata entity with this id.", source: "wikidata.org" };
        }
        const claims = ent.claims || {};
        const facts = {};
        const refIds = new Set();
        for (const [prop, key] of Object.entries(WD_PROPS)) {
          const statements = claims[prop];
          if (!Array.isArray(statements) || !statements.length) continue;
          // Preferred-rank statements first, then normal; deprecated dropped.
          const ranked = [
            ...statements.filter((s) => s.rank === "preferred"),
            ...statements.filter((s) => s.rank === "normal"),
          ];
          const seen = new Set();
          const values = ranked
            .map((s) => renderSnak(s.mainsnak))
            .filter((v) => {
              if (v === null) return false;
              // Dedupe repeated statements (same value with different qualifiers).
              const key = JSON.stringify(v);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, WD_MAX_VALUES_PER_PROP);
          if (!values.length) continue;
          facts[key] = values;
          for (const v of values) if (v && typeof v === "object" && v.id) refIds.add(v.id);
        }
        // One batched follow-up resolves item references to labels (≤50 ids).
        if (refIds.size) {
          const ids = [...refIds].slice(0, 50).join("|");
          try {
            const { data: labelData } = await getJson(
              `${WD_API}?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=labels&languages=en&format=json&origin=*`,
              "Wikidata"
            );
            const labelOf = (qid) => labelData?.entities?.[qid]?.labels?.en?.value ?? null;
            for (const values of Object.values(facts)) {
              for (const v of values) if (v && typeof v === "object" && v.id) v.label = labelOf(v.id);
            }
          } catch { /* labels are an enhancement — the Q-ids still stand alone */ }
        }
        let statementCount = 0;
        for (const arr of Object.values(claims)) statementCount += Array.isArray(arr) ? arr.length : 0;
        return {
          found: true,
          id,
          label: ent.labels?.en?.value ?? null,
          description: ent.descriptions?.en?.value ?? null,
          aliases: (ent.aliases?.en || []).map((a) => a.value).slice(0, 10),
          facts,
          statementCount,
          source: "wikidata.org",
        };
      }
      if (!name) throw bad(`Provide "id" (e.g. Q312) or "name" (entity name to search)`);
      if (name.length > 200) throw bad(`"name" is capped at 200 characters`);
      const { data } = await getJson(
        `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&type=item&limit=10&format=json&origin=*`,
        "Wikidata"
      );
      const matches = (Array.isArray(data?.search) ? data.search : []).map((m) => ({
        id: m.id,
        label: m.label ?? null,
        description: m.description ?? null,
      }));
      return {
        found: matches.length > 0,
        query: name,
        matches,
        note: matches.length ? "Ranked by Wikidata relevance - pass a candidate's id back for the full fact set." : "No Wikidata match for this name.",
        source: "wikidata.org",
      };
    },
  },

  // ===========================================================================
  // gravatar-check — email → avatar existence + public profile signal.
  // ===========================================================================
  {
    route: "POST /api/gravatar-check",
    name: "Gravatar existence check",
    slug: "gravatar-check",
    category: "network",
    price: "$0.002",
    description:
      "Check whether an email address has a Gravatar: hashes the normalized email (MD5, pure CPU - the raw address is never sent upstream), probes gravatar.com for an avatar, and fetches the public profile when one exists (display name, username, profile URL). Accepts a raw email or a precomputed MD5/SHA-256 hash. Signal-only: a Gravatar's existence suggests a real, web-active address but does NOT verify identity or deliverability - pair with /api/email-validate for MX checks.",
    tags: ["network", "email", "gravatar", "avatar", "enrichment", "people", "signal"],
    discovery: {
      bodyType: "json",
      input: { hash: "205e460b479e2e5b48aec07710c08d50" },
      inputSchema: {
        properties: {
          email: { type: "string", description: "Email address to check (hashed locally; never sent upstream)." },
          hash: { type: "string", description: "Precomputed lowercase MD5 (32 hex) or SHA-256 (64 hex) of the normalized email. Provide email OR hash." },
        },
      },
      output: {
        example: {
          hash: "205e460b479e2e5b48aec07710c08d50",
          exists: true,
          avatarUrl: "https://gravatar.com/avatar/205e460b479e2e5b48aec07710c08d50",
          profile: { displayName: "Beau Lebens", preferredUsername: "beau", profileUrl: "https://gravatar.com/beau" },
          note: "Existence is a web-activity signal only - it does not verify identity or deliverability.",
        },
      },
    },
    handler: async (i) => {
      const email = typeof i.email === "string" ? i.email.trim().toLowerCase() : "";
      let hash = typeof i.hash === "string" ? i.hash.trim().toLowerCase() : "";
      if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(`"email" does not look like an email address`);
        hash = createHash("md5").update(email).digest("hex");
      } else if (hash) {
        if (!HASH_RE.test(hash)) throw bad(`"hash" must be a lowercase 32-char MD5 or 64-char SHA-256 hex digest`);
      } else {
        throw bad(`Provide "email" or a precomputed "hash"`);
      }
      // d=404 turns the default-image fallback into a miss; s=1 keeps the probe tiny.
      const avatar = await gravatarProbe(`https://gravatar.com/avatar/${hash}?d=404&s=1`, "Gravatar", "image/*");
      const exists = avatar.status === 200;
      try { avatar.body?.cancel?.(); } catch { /* probe body unused */ }
      let profile = null;
      if (exists) {
        try {
          const res = await gravatarProbe(`https://gravatar.com/${hash}.json`, "Gravatar", "application/json");
          if (res.status === 200) {
            const entry = (await res.json())?.entry?.[0];
            if (entry) {
              profile = {
                displayName: entry.displayName ?? null,
                preferredUsername: entry.preferredUsername ?? null,
                profileUrl: entry.profileUrl ?? null,
                location: entry.currentLocation ?? null,
              };
            }
          }
        } catch { /* profile is optional signal — avatar existence already answered */ }
      }
      return {
        hash,
        exists,
        avatarUrl: exists ? `https://gravatar.com/avatar/${hash}` : null,
        profile,
        note: "Existence is a web-activity signal only - it does not verify identity or deliverability.",
      };
    },
  },

  // ===========================================================================
  // github-repo — public repository enrichment via GitHub REST.
  // ===========================================================================
  {
    route: "POST /api/github-repo",
    name: "GitHub repository enrichment",
    slug: "github-repo",
    category: "data",
    price: "$0.005",
    description:
      "Enrich a public GitHub repository: stars, forks, watchers, open issues, license, topics, primary language plus the full language byte mix with percentages, created/last-push timestamps, default branch, archived/fork flags, and homepage. Keyless (shared per-IP rate limit; the server optionally uses a GITHUB_TOKEN env var for a higher ceiling). Unknown repos return 404.",
    tags: ["data", "github", "repository", "oss", "enrichment", "dev", "stars"],
    discovery: {
      bodyType: "json",
      input: { owner: "MikeyPetrillo", repo: "Agent402" },
      inputSchema: {
        properties: {
          owner: { type: "string", description: "Repository owner (user or org)." },
          repo: { type: "string", description: "Repository name." },
        },
        required: ["owner", "repo"],
      },
      output: {
        example: {
          fullName: "MikeyPetrillo/Agent402",
          description: "Open-source x402 + MCP tool server",
          stars: 12, forks: 3, watchers: 12, openIssues: 4,
          license: "MIT", topics: ["x402", "mcp"],
          language: "JavaScript",
          languages: [{ language: "JavaScript", bytes: 1000000, percent: 98.2 }],
          pushedAt: "2026-07-12T20:11:04Z", createdAt: "2026-05-28T01:02:03Z",
          defaultBranch: "main", archived: false, fork: false,
          homepage: "https://agent402.tools",
          url: "https://github.com/MikeyPetrillo/Agent402",
          source: "api.github.com",
        },
      },
    },
    handler: async (i) => {
      const owner = typeof i.owner === "string" ? i.owner.trim() : "";
      const repo = typeof i.repo === "string" ? i.repo.trim() : "";
      if (!GH_OWNER_RE.test(owner)) throw bad(`"owner" must be a GitHub user/org name (letters, digits, hyphens; max 39 chars)`);
      if (!GH_REPO_RE.test(repo) || repo.length > 128 || repo === "." || repo.includes("..")) throw bad(`"repo" must be a GitHub repository name (letters, digits, . _ -; no ".." segments)`);
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      const { status, data } = await getJson(base, "GitHub", ghHeaders());
      if (status === 404 || !data || typeof data !== "object") {
        throw bad(`Repository ${owner}/${repo} not found (or private)`, 404);
      }
      // Language byte mix — best-effort second call; the core record stands alone.
      let languages = null;
      try {
        const { status: ls, data: langs } = await getJson(`${base}/languages`, "GitHub", ghHeaders());
        if (ls === 200 && langs && typeof langs === "object") {
          const total = Object.values(langs).reduce((s, n) => s + n, 0) || 1;
          languages = Object.entries(langs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([language, bytes]) => ({ language, bytes, percent: Math.round((bytes / total) * 1000) / 10 }));
        }
      } catch { /* per-IP quota may not stretch to the second call — mix stays null */ }
      return {
        fullName: data.full_name ?? `${owner}/${repo}`,
        description: data.description ?? null,
        stars: data.stargazers_count ?? 0,
        forks: data.forks_count ?? 0,
        watchers: data.subscribers_count ?? data.watchers_count ?? 0,
        openIssues: data.open_issues_count ?? 0,
        license: data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : data.license?.name ?? null,
        topics: Array.isArray(data.topics) ? data.topics.slice(0, 20) : [],
        language: data.language ?? null,
        languages,
        pushedAt: data.pushed_at ?? null,
        createdAt: data.created_at ?? null,
        defaultBranch: data.default_branch ?? null,
        archived: Boolean(data.archived),
        fork: Boolean(data.fork),
        homepage: data.homepage || null,
        url: data.html_url ?? `https://github.com/${owner}/${repo}`,
        source: "api.github.com",
      };
    },
  },

  // ===========================================================================
  // favicon-grab — site favicon/logo → base64 data URI + declared sizes.
  // ===========================================================================
  {
    route: "POST /api/favicon-grab",
    name: "Site favicon grabber",
    slug: "favicon-grab", aliases: ["site-favicon-grabber", "favicon"],
    category: "web",
    price: "$0.003",
    description:
      "Fetch a site's favicon/logo: reads the page's declared <link rel=icon…> tags (all variants with their sizes and types), deterministically picks the largest declared icon (falling back to /favicon.ico), fetches it, and returns the bytes as a base64 data URI plus the resolved icon URL and content type. Icons over 256KB return the URL and metadata without the inline data URI. SSRF-guarded - private-network hosts are rejected. Sites with no reachable icon return {found:false}.",
    tags: ["web", "favicon", "icon", "logo", "enrichment", "domain", "brand"],
    discovery: {
      bodyType: "json",
      // The example target is NOT github.com on purpose (2026-09-14): the
      // strict sweep runs on a GitHub Actions runner, and github.com answers a
      // runner's page fetch differently from a browser - the HTML read failed,
      // `declared` came back empty, and the /favicon.ico fallback still
      // succeeded, so the tool reported found:true with nothing declared and
      // the sweep rightly failed the example. Wikipedia serves the same page
      // to everyone and declares two icons. Since 2026-10-07 the example is our
      // own home page, which declares four, so it never depends on another site.
      input: { url: "https://agent402.tools" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Site URL or bare domain (https:// is assumed when omitted)." },
        },
        required: ["url"],
      },
      output: {
        example: {
          found: true,
          url: "https://agent402.tools/",
          iconUrl: "https://agent402.tools/favicon.ico?v=3",
          finalIconUrl: "https://agent402.tools/favicon.ico?v=3",
          contentType: "image/png",
          bytes: 76462,
          dataUri: "data:image/png;base64,iVBORw0KGgo…",
          declared: [
            { href: "https://agent402.tools/favicon.svg?v=3", rel: "icon", sizes: null, type: "image/svg+xml", mask: false },
            { href: "https://agent402.tools/favicon.ico?v=3", rel: "icon", sizes: "512x512", type: "image/png", mask: false },
            { href: "https://agent402.tools/favicon.ico?v=3", rel: "shortcut icon", sizes: null, type: null, mask: false },
            { href: "https://agent402.tools/logo.png?v=2", rel: "apple-touch-icon", sizes: null, type: null, mask: false },
          ],
        },
      },
    },
    handler: async (i) => {
      let raw = typeof i.url === "string" ? i.url.trim() : "";
      if (!raw) throw bad(`"url" is required - a site URL or bare domain`);
      if (raw.length > 2048) throw bad(`"url" is capped at 2048 characters`);
      if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
      // Page fetch (SSRF-guarded). A page that won't serve HTML still gets the
      // /favicon.ico fallback below.
      let page = null;
      try {
        page = await safeFetch(raw, { maxBytes: PAGE_MAX_BYTES });
      } catch (e) {
        if (e.statusCode === 400) throw e; // SSRF block / invalid URL — caller error, stop here
        page = null; // 4xx/5xx/timeout page — still try /favicon.ico
      }
      const baseUrl = page?.finalUrl || raw;
      const declared = page?.html ? parseDeclaredIcons(page.html, baseUrl) : [];
      const fallback = new URL("/favicon.ico", baseUrl).href;
      // Candidate order: best declared icon, then /favicon.ico.
      const chosen = pickIcon(declared);
      const candidates = [...(chosen ? [chosen.href] : []), fallback];
      let icon = null, iconUrl = null;
      for (const candidate of [...new Set(candidates)]) {
        try {
          icon = await fetchIcon(candidate);
          iconUrl = candidate;
          break;
        } catch (e) {
          if (e.statusCode === 413) throw e; // oversized icon is a real answer boundary, not a miss
          /* 4xx/5xx/timeout — try the next candidate */
        }
      }
      if (!icon) {
        return { found: false, url: baseUrl, iconUrl: null, declared, note: "No reachable favicon - none declared and /favicon.ico did not serve." };
      }
      const inline = icon.buffer.length <= ICON_DATAURI_MAX;
      return {
        found: true,
        url: baseUrl,
        iconUrl,
        finalIconUrl: icon.finalUrl,
        contentType: icon.contentType,
        bytes: icon.buffer.length,
        dataUri: inline ? `data:${icon.contentType};base64,${icon.buffer.toString("base64")}` : null,
        ...(inline ? {} : { note: `Icon exceeds ${ICON_DATAURI_MAX / 1024}KB - fetch iconUrl directly.` }),
        declared,
      };
    },
  },
];
