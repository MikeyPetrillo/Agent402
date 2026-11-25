// The guide to x402 and MPP for people: ask402.ai, a site this
// project's maintainer also operates. It answers the general questions (what
// x402 is, what MPP is); the pages here cover how each protocol runs on this
// server and link there for the introduction. One place for its addresses, so
// a page never types one.
export const GUIDE_SITE = "https://www.ask402.ai";
export const GUIDE_SITE_NAME = "ask402.ai";
export const GUIDE_EXPLAINERS = Object.freeze({
  x402: `${GUIDE_SITE}/x402/what-is-x402`,
  mpp: `${GUIDE_SITE}/mpp/what-is-mpp`,
});

/** An inline link to the guide, drawn as a page's own inline links are. `label` is plain text. */
export const guideLink = (href, label) =>
  `<a href="${href}" rel="noopener" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${label}</a>`;
