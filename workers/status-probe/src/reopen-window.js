// A check that fails again soon after its issue was closed reopens that issue
// instead of filing a new one, so one ongoing problem keeps one issue number.
//
// The one rule, read by the status Worker (./index.js) and by every workflow
// through scripts/check-issue.js: the most recent issue under the check's
// exact title, filed by a trusted author (the Actions bot or the account the
// Worker posts as), closed within REOPEN_WINDOW_DAYS. Older than that, or
// none, and a new issue is filed. Dependency-free: the Worker bundles it.
export const REOPEN_WINDOW_DAYS = 7;
export const REOPEN_WINDOW_MS = REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const BOT_LOGINS = Object.freeze(["github-actions[bot]", "app/github-actions"]);
/** True when `login` is the Actions bot or one of `trusted`. */
export const trustedAuthor = (login, trusted = []) => [...BOT_LOGINS, ...trusted.map((t) => String(t || "").toLowerCase())].includes(String(login || "").toLowerCase());

/**
 * The issue number to reopen for `title`, or null.
 * rows: [{ number, title, author (login string), closedAt (ISO), state? }]
 */
export function reopenCandidate(rows, { title, trusted = [], now = Date.now() } = {}) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.title !== title || !Number.isInteger(r.number)) continue;
    if (r.state && String(r.state).toLowerCase() !== "closed") continue;
    if (!trustedAuthor(r.author, trusted.filter(Boolean))) continue;
    const at = Date.parse(r.closedAt || "");
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > REOPEN_WINDOW_MS) continue;
    if (!best || at > best.at) best = { number: r.number, at };
  }
  return best ? best.number : null;
}
