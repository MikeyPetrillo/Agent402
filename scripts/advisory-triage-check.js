#!/usr/bin/env node
// Repository security advisories left in "triage". A private vulnerability
// report waits on a maintainer to accept or close it; this check pages when one
// has waited longer than ADVISORY_TRIAGE_MAX_HOURS (default 24).
//
// Reads GET /repos/{owner}/{repo}/security-advisories?state=triage with the
// fine-grained ADVISORY_READ_TOKEN (Security advisories: read, this repository
// only); the built-in GITHUB_TOKEN cannot read advisories. Follows Link
// rel="next" pages on the same origin only, so the token never leaves it.
//
// Output is public (the heartbeat posts it to an issue in a public repo): GHSA
// ids, ages in hours and counts only. Never a summary, description, severity,
// reporter or the token.
//
// Env:
//   ADVISORY_READ_TOKEN       the read token (missing = unreadable, never a pass)
//   GITHUB_REPOSITORY         owner/repo
//   GITHUB_API_URL            API base (Actions sets it; default api.github.com)
//   ADVISORY_TRIAGE_ACK       comma list of GHSA ids an operator acknowledged; they never page
//   ADVISORY_TRIAGE_MAX_HOURS age past which a triage advisory pages (default 24)
//   ADVISORY_BODY_FILE        where to write the issue body (markdown), optional
//
// Exit: 0 none stale, 1 at least one stale (page), 2 unreadable (page).
import { writeFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_PAGES = 20;
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/i;

export function parseAck(raw) {
  return new Set(String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function nextLink(header) {
  for (const part of String(header || "").split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

// Every advisory in triage, across pages. Throws an Error whose .reason is a
// short public word (never a response body or a header value).
export async function readTriage({ token, repo, apiBase = "https://api.github.com", fetchImpl = fetch, timeoutMs = 15000 }) {
  const fail = (reason) => Object.assign(new Error(reason), { reason });
  if (!token) throw fail("token missing");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ""))) throw fail("repository unknown");
  const base = new URL(apiBase.replace(/\/+$/, "") + "/");
  let url = new URL(`repos/${repo}/security-advisories?state=triage&per_page=100`, base).href;
  const out = [];
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw fail("too many pages");
    if (new URL(url).origin !== base.origin) throw fail("next page on another origin");
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "agent402-heartbeat",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw fail("network error");
    }
    if (res.status !== 200) throw fail(`http ${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw fail("unparseable answer"); }
    if (!Array.isArray(body)) throw fail("unexpected answer shape");
    out.push(...body);
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

export function classify(advisories, { ack = new Set(), maxHours = 24, now = Date.now() } = {}) {
  const rows = [];
  for (const a of advisories) {
    if (!a || a.state !== "triage") continue; // a published, closed or draft answer is not triage
    const id = GHSA_RE.test(String(a.ghsa_id || "")) ? String(a.ghsa_id) : null;
    const created = Date.parse(a.created_at || "");
    const ageHours = Number.isFinite(created) ? Math.max(0, (now - created) / 3.6e6) : Infinity;
    rows.push({ id, ageHours, acked: id != null && ack.has(id.toLowerCase()) });
  }
  const stale = rows.filter((r) => !r.acked && r.ageHours > maxHours).sort((x, y) => y.ageHours - x.ageHours);
  return { triage: rows.length, acked: rows.filter((r) => r.acked).length, stale };
}

const fmtAge = (h) => (Number.isFinite(h) ? `${Math.floor(h)} h` : "age unknown");
const fmtId = (id) => id || "(id not in GHSA form)";

export function bodyFor(state, { result, reason, maxHours, at }) {
  if (state === "unreadable") {
    return `The heartbeat could not read this repository's security advisories at ${at} (${reason}), so a report waiting in triage would go unseen. The read uses the ADVISORY_READ_TOKEN Actions secret: a fine-grained token on this repository with Security advisories read. Check that it is set and not expired. Auto-closes on the next readable check.\n`;
  }
  const lines = result.stale.map((r) => `- ${fmtId(r.id)}: in triage ${fmtAge(r.ageHours)}`);
  return `Checked at ${at}: ${result.stale.length} security ${result.stale.length === 1 ? "advisory has" : "advisories have"} been in triage for more than ${maxHours} h (${result.triage} in triage, ${result.acked} acknowledged).\n\n${lines.join("\n")}\n\nAccept, close or answer each in the repository's Security tab. To stop one paging while it waits on the reporter, add its GHSA id to the repository variable ADVISORY_TRIAGE_ACK (comma list). Auto-closes when none is waiting.\n`;
}

async function main() {
  const maxHours = Number(process.env.ADVISORY_TRIAGE_MAX_HOURS) > 0 ? Number(process.env.ADVISORY_TRIAGE_MAX_HOURS) : 24;
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const bodyFile = process.env.ADVISORY_BODY_FILE;
  let state, result, reason;
  try {
    const list = await readTriage({
      token: process.env.ADVISORY_READ_TOKEN,
      repo: process.env.GITHUB_REPOSITORY,
      apiBase: process.env.GITHUB_API_URL || "https://api.github.com",
    });
    result = classify(list, { ack: parseAck(process.env.ADVISORY_TRIAGE_ACK), maxHours });
    state = result.stale.length ? "stale" : "clear";
  } catch (e) {
    state = "unreadable";
    reason = e?.reason || "read failed";
  }
  if (state === "unreadable") {
    console.log(`advisory triage: UNREADABLE (${reason})`);
  } else {
    console.log(`advisory triage: ${state} (${result.triage} in triage, ${result.acked} acknowledged, ${result.stale.length} past ${maxHours} h)`);
    for (const r of result.stale) console.log(`  ${fmtId(r.id)} ${fmtAge(r.ageHours)}`);
  }
  if (bodyFile && state !== "clear") writeFileSync(bodyFile, bodyFor(state, { result, reason, maxHours, at }));
  process.exitCode = state === "clear" ? 0 : state === "stale" ? 1 : 2;
}

const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1] || "")).href; } catch { return ""; } })();
if (import.meta.url === entry) main();
