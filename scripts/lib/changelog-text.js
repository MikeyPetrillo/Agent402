// All the changelog text the site serves. /changelog shows the most recent
// entries (CHANGELOG_RECENT, src/changelog.js) and /changelog/archive every
// older one, so an entry is "on the site" when it is on either page. A suite
// that looks for a specific entry reads both through one of these, never
// /changelog alone: an entry leaves that page as newer ones are added.
export const CHANGELOG_PATHS = Object.freeze(["/changelog", "/changelog/archive"]);

/** From a booted server: both pages' HTML joined. Throws when either page is
 *  not a 200, so a missing archive never reads as "the entry is absent". */
export async function servedChangelogText(baseUrl, { fetchImpl = fetch, headers } = {}) {
  const parts = [];
  for (const p of CHANGELOG_PATHS) {
    const r = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}${p}`, headers ? { headers } : undefined);
    if (r.status !== 200) throw new Error(`${p} answered ${r.status}`);
    parts.push(await r.text());
  }
  return parts.join("\n");
}

/** Offline, from the module itself (pass the imported src/changelog.js). */
export function renderedChangelogText(changelogModule, baseUrl = "https://example.test") {
  return `${changelogModule.changelogPage(baseUrl)}\n${changelogModule.changelogArchivePage(baseUrl)}`;
}
