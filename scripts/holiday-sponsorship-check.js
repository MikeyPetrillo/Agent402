#!/usr/bin/env node
// The holiday data source (src/tools/holiday-source.js) allows commercial use
// only while this service holds an active GitHub sponsorship of its
// maintainer's organization. This check reads that sponsorship from GitHub's
// GraphQL API and pages when it is not active, so a lapse is known before the
// holiday tools keep serving past their terms.
//
// Two reads, the first that has a token:
//   SPONSORSHIP_READ_TOKEN  a token of the sponsoring account with read:user
//                           (a classic token, or a fine-grained one that can
//                           read the account's sponsorships): reads
//                           viewer.sponsorshipsAsSponsor(activeOnly: true)
//                           and finds the source's organization there; it
//                           sees a private sponsorship too.
//   GH_TOKEN                any token (the workflow's own): reads
//                           organization.isSponsoredBy(accountLogin), which
//                           GitHub answers true only for a PUBLIC sponsorship.
// Env: SPONSOR_LOGIN (the sponsoring account, the repository owner by
// default), SPONSORABLE_LOGIN (default "nager"), GITHUB_API_URL.
//
// The issue a page opens is public: fixed text (scripts/lib/monitor-issue-text.js),
// never the login, tier or token. Exit: 0 active, 1 not active (page),
// 2 unreadable (page, its own issue).
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Read the sponsorship. Resolves { active, via }; throws an Error whose
 *  .reason is a short public word (never a body or a token). */
export async function readSponsorship({ readToken, ghToken, sponsor, sponsorable = "nager", apiBase = "https://api.github.com", fetchImpl = fetch, timeoutMs = 15000 }) {
  const fail = (reason) => Object.assign(new Error(reason), { reason });
  if (!LOGIN_RE.test(String(sponsorable))) throw fail("sponsorable login invalid");
  const token = readToken || ghToken;
  if (!token) throw fail("token missing");
  const viaViewer = Boolean(readToken);
  if (!viaViewer && !LOGIN_RE.test(String(sponsor || ""))) throw fail("sponsor login invalid");
  const query = viaViewer
    ? "query { viewer { sponsorshipsAsSponsor(first: 100, activeOnly: true) { nodes { sponsorable { ... on Organization { login } ... on User { login } } } } } }"
    : "query($org: String!, $who: String!) { organization(login: $org) { isSponsoredBy(accountLogin: $who) } }";
  let res;
  try {
    res = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "agent402-heartbeat" },
      body: JSON.stringify(viaViewer ? { query } : { query, variables: { org: sponsorable, who: sponsor } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw fail("request failed"); }
  if (!res.ok) throw fail(`HTTP ${res.status}`);
  let j;
  try { j = await res.json(); } catch { throw fail("answer not JSON"); }
  if (Array.isArray(j?.errors) && j.errors.length) throw fail("GraphQL error");
  if (viaViewer) {
    const nodes = j?.data?.viewer?.sponsorshipsAsSponsor?.nodes;
    if (!Array.isArray(nodes)) throw fail("answer shape");
    return { active: nodes.some((n) => String(n?.sponsorable?.login || "").toLowerCase() === sponsorable.toLowerCase()), via: "viewer" };
  }
  const v = j?.data?.organization?.isSponsoredBy;
  if (typeof v !== "boolean") throw fail("answer shape");
  return { active: v, via: "public" };
}

async function main() {
  const env = process.env;
  try {
    const r = await readSponsorship({
      readToken: String(env.SPONSORSHIP_READ_TOKEN || "").trim(), ghToken: String(env.GH_TOKEN || "").trim(),
      sponsor: String(env.SPONSOR_LOGIN || String(env.GITHUB_REPOSITORY || "").split("/")[0] || "").trim(),
      sponsorable: String(env.SPONSORABLE_LOGIN || "nager").trim(), apiBase: env.GITHUB_API_URL || "https://api.github.com",
    });
    console.log(`holiday source sponsorship: ${r.active ? "active" : "NOT ACTIVE"} (read: ${r.via === "viewer" ? "the sponsoring account's own list" : "the public sponsorship flag"})`);
    if (!r.active && r.via === "public") console.log("note: a private sponsorship reads as not active here; set SPONSORSHIP_READ_TOKEN (read:user) to read it");
    process.exit(r.active ? 0 : 1);
  } catch (e) {
    console.log(`holiday source sponsorship: UNREADABLE (${e.reason || "error"})`);
    process.exit(2);
  }
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main();
