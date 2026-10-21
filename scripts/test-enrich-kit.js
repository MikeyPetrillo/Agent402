// scripts/test-enrich-kit.js
// Offline tests for src/tools/enrich-kit.js. No network required.
//
// Pattern matches scripts/test-contract-kit.js:
//   • Catalog envelope + input validation always run (deterministic).
//   • Live upstream calls (GLEIF, Wikidata, Gravatar, GitHub, favicon fetch)
//     are opt-in via ENRICH_LIVE_TEST=1.

import { ENRICH_TOOLS } from "../src/tools/enrich-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

const h = (slug) => ENRICH_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(ENRICH_TOOLS.length === 5, `5 tools exported (got ${ENRICH_TOOLS.length})`);
const SPEC = {
  "lei-lookup": { price: "$0.005", category: "data" },
  "wikidata-entity": { price: "$0.005", category: "data" },
  "gravatar-check": { price: "$0.002", category: "network" },
  "github-repo": { price: "$0.005", category: "data" },
  "favicon-grab": { price: "$0.003", category: "web" },
};
for (const t of ENRICH_TOOLS) {
  const spec = SPEC[t.slug];
  ok(!!spec, `${t.slug}: is a shortlist slug`);
  if (!spec) continue;
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug} route`);
  ok(t.price === spec.price, `${t.slug}: priced ${spec.price} (got ${t.price})`);
  ok(t.category === spec.category, `${t.slug}: category=${spec.category} (got ${t.category})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  // All five reach the network — they must be wallet-only (PoW can't farm egress).
  ok(WALLET_ONLY_SLUGS.has(t.slug), `${t.slug}: in WALLET_ONLY_SLUGS`);
}

// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Input validation — deterministic, no network
// ----------------------------------------------------------------------------
// lei-lookup
await throws(h("lei-lookup")({}), 400, "lei-lookup: neither lei nor name");
await throws(h("lei-lookup")({ lei: "short" }), 400, "lei-lookup: malformed LEI");
await throws(h("lei-lookup")({ lei: "HWUPKR0MPOU8FGXBT39!" }), 400, "lei-lookup: non-alphanumeric LEI");
await throws(h("lei-lookup")({ name: "x".repeat(201) }), 400, "lei-lookup: name over 200 chars");

// wikidata-entity
await throws(h("wikidata-entity")({}), 400, "wikidata-entity: neither id nor name");
await throws(h("wikidata-entity")({ id: "P31" }), 400, "wikidata-entity: property id rejected");
await throws(h("wikidata-entity")({ id: "Q" }), 400, "wikidata-entity: bare Q rejected");
await throws(h("wikidata-entity")({ id: "Q12345678901" }), 400, "wikidata-entity: overlong id rejected");
await throws(h("wikidata-entity")({ name: "x".repeat(201) }), 400, "wikidata-entity: name over 200 chars");

// gravatar-check
await throws(h("gravatar-check")({}), 400, "gravatar-check: neither email nor hash");
await throws(h("gravatar-check")({ email: "not-an-email" }), 400, "gravatar-check: malformed email");
await throws(h("gravatar-check")({ hash: "zz" }), 400, "gravatar-check: malformed hash");
await throws(h("gravatar-check")({ hash: "ABCDEF" }), 400, "gravatar-check: wrong-length hash");

// github-repo
await throws(h("github-repo")({}), 400, "github-repo: missing owner+repo");
await throws(h("github-repo")({ owner: "MikeyPetrillo" }), 400, "github-repo: missing repo");
await throws(h("github-repo")({ owner: "a/b", repo: "Agent402" }), 400, "github-repo: slash in owner rejected");
await throws(h("github-repo")({ owner: "MikeyPetrillo", repo: "x?y" }), 400, "github-repo: bad repo charset rejected");
await throws(h("github-repo")({ owner: "..%2f..", repo: "x" }), 400, "github-repo: traversal-shaped owner rejected");
// Path traversal: owner ".." would URL-normalize /repos/../user into an
// arbitrary single-segment GitHub API endpoint — must 400 at validation.
await throws(h("github-repo")({ owner: "..", repo: "user" }), 400, "github-repo: owner '..' traversal rejected");
await throws(h("github-repo")({ owner: ".", repo: "x" }), 400, "github-repo: owner '.' rejected");
await throws(h("github-repo")({ owner: "dotted.owner", repo: "x" }), 400, "github-repo: dotted owner rejected (GitHub usernames have no dots)");
await throws(h("github-repo")({ owner: "-leadinghyphen", repo: "x" }), 400, "github-repo: hyphen-leading owner rejected");
await throws(h("github-repo")({ owner: "a".repeat(40), repo: "x" }), 400, "github-repo: owner over 39 chars rejected");
await throws(h("github-repo")({ owner: "MikeyPetrillo", repo: ".." }), 400, "github-repo: repo '..' rejected");
await throws(h("github-repo")({ owner: "MikeyPetrillo", repo: "." }), 400, "github-repo: repo '.' rejected");
await throws(h("github-repo")({ owner: "MikeyPetrillo", repo: "a..b" }), 400, "github-repo: '..' substring in repo rejected");
// Dotted REPO names are legit (.github, repo.js) — validation must pass and the
// handler must reach the fetch. Whatever happens upstream (404 for a repo that
// doesn't exist, 5xx offline), it must NOT be a validation 400.
try {
  await h("github-repo")({ owner: "MikeyPetrillo", repo: "repo.js" });
  ok(true, "github-repo: dotted repo passes validation (reached upstream)");
} catch (e) {
  ok(e.statusCode !== 400, `github-repo: dotted repo passes validation — non-400 upstream error is fine (got ${e.statusCode}: ${e.message})`);
}

// A private repository (what a token with access would see) answers exactly
// like a missing one. The GitHub API is stubbed: no egress.
{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u === "https://api.github.com/repos/acme/hidden") {
      return new Response(JSON.stringify({ full_name: "acme/hidden", private: true, description: "internal notes", stargazers_count: 3 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
  try {
    let hidden = null, missing = null;
    try { await h("github-repo")({ owner: "acme", repo: "hidden" }); } catch (e) { hidden = e; }
    try { await h("github-repo")({ owner: "acme", repo: "missing" }); } catch (e) { missing = e; }
    ok(seen.includes("https://api.github.com/repos/acme/hidden"), "github-repo: (control) the stubbed API was read");
    ok(hidden?.statusCode === 404 && missing?.statusCode === 404 && hidden.message.replace("hidden", "X") === missing.message.replace("missing", "X"),
      `github-repo: a private repository answers 404 like a missing one (${hidden?.statusCode} ${hidden?.message})`);
  } finally { globalThis.fetch = realFetch; }
}

// favicon-grab
await throws(h("favicon-grab")({}), 400, "favicon-grab: missing url");
await throws(h("favicon-grab")({ url: "x".repeat(2049) }), 400, "favicon-grab: url over 2048 chars");
await throws(h("favicon-grab")({ url: "ftp://example.com" }), 400, "favicon-grab: non-http scheme rejected");
await throws(h("favicon-grab")({ url: "http://127.0.0.1/x" }), 400, "favicon-grab: loopback SSRF rejected");
await throws(h("favicon-grab")({ url: "http://169.254.169.254/latest/meta-data" }), 400, "favicon-grab: metadata IP SSRF rejected");
await throws(h("favicon-grab")({ url: "http://[::1]/" }), 400, "favicon-grab: IPv6 loopback SSRF rejected");

// ----------------------------------------------------------------------------
// Live upstream checks — opt-in (ENRICH_LIVE_TEST=1)
// ----------------------------------------------------------------------------
if (process.env.ENRICH_LIVE_TEST === "1") {
  const live = async (label, fn, check) => {
    try {
      const r = await fn();
      if (check(r)) { liveOk++; console.log(`live ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
      else { liveErr++; console.error(`LIVE FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 200)}`); }
    } catch (e) {
      liveErr++; console.error(`LIVE FAIL - ${label}: threw ${e.statusCode} ${e.message}`);
    }
  };
  await live("lei-lookup Apple LEI", () => h("lei-lookup")({ lei: "HWUPKR0MPOU8FGXBT394" }),
    (r) => r.found === true && /APPLE/i.test(r.record.legalName));
  await live("lei-lookup name search", () => h("lei-lookup")({ name: "Apple Inc" }),
    (r) => r.found === true && r.matches.length > 0);
  await live("wikidata-entity Q312", () => h("wikidata-entity")({ id: "Q312" }),
    (r) => r.found === true && /Apple/i.test(r.label) && r.facts && Object.keys(r.facts).length > 0);
  await live("wikidata-entity name search", () => h("wikidata-entity")({ name: "Apple Inc" }),
    (r) => r.found === true && r.matches.some((m) => m.id === "Q312"));
  await live("gravatar-check docs hash", () => h("gravatar-check")({ hash: "205e460b479e2e5b48aec07710c08d50" }),
    (r) => typeof r.exists === "boolean" && r.hash === "205e460b479e2e5b48aec07710c08d50");
  await live("gravatar-check email path", () => h("gravatar-check")({ email: "no-such-mailbox-402@example.com" }),
    (r) => r.exists === false && r.avatarUrl === null);
  await live("github-repo Agent402", () => h("github-repo")({ owner: "MikeyPetrillo", repo: "Agent402" }),
    (r) => r.fullName === "MikeyPetrillo/Agent402" && typeof r.stars === "number");
  await live("favicon-grab github.com", () => h("favicon-grab")({ url: "https://github.com" }),
    (r) => r.found === true && typeof r.dataUri === "string" && r.dataUri.startsWith("data:image"));
  console.log(`\nlive: ${liveOk} ok, ${liveErr} failed`);
}

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed${process.env.ENRICH_LIVE_TEST === "1" ? ` (live: ${liveOk}/${liveOk + liveErr})` : " (live checks skipped — set ENRICH_LIVE_TEST=1)"}`);
if (fail > 0 || liveErr > 0) process.exit(1);
