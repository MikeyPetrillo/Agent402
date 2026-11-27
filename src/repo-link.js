// ONE place the public source link is written.
//
// The footer, the Organization JSON-LD `sameAs` on six pages, /company,
// /terms, /security, /#why, the MCP connector's listing copy and the discovery
// manifest all point at the repository. Every one of them spelled the URL out,
// and the URL contains a PERSONAL GitHub handle.
//
// That matters because of what it joins. The site publishes receiving wallet
// addresses on purpose - being checkable against the chain is the product - and
// a wallet is only a number until something ties it to a person. The repo link
// is that something: wallet -> agent402.tools -> a named individual -> public
// records. The business identity (Havok Holdings LLC) is already correct
// everywhere it appears; the source link was the one public surface still
// carrying a person.
//
// Moving the repository to an organisation account is the actual fix and it
// happens on GitHub, not here. What this does is make the move FREE: set
// AGENT402_REPO_URL and every surface follows in one deploy, with no sweep
// through fifteen files hunting for a spelling that a new page may already have
// copied. Unset, the rendered bytes are identical to before.
//
// scripts/test-repo-link.js fails if a served module spells the URL out again.
const DEFAULT_REPO_URL = "https://github.com/MikeyPetrillo/Agent402";

/** Canonical https URL of the public source repository, no trailing slash. */
export const REPO_URL = ((process.env.AGENT402_REPO_URL || "").trim() || DEFAULT_REPO_URL).replace(/\/+$/, "");

/** "owner/name", for the surfaces that print the slug rather than the URL. */
export const REPO_SLUG = REPO_URL.replace(/^https?:\/\/github\.com\//i, "");

/** "io.github.owner" - the repository account's namespace: the Glama connector
 *  listing and the earlier MCP Registry name. The MCP Registry name itself is
 *  the domain's (MCP_REGISTRY_NAME, src/org-profiles.js). */
export const REPO_NAMESPACE = `io.github.${REPO_SLUG.split("/")[0]}`;

/** A path inside the repository: repoUrl("issues"), repoUrl("wiki/Security-Model"). */
export const repoUrl = (path = "") => (path ? `${REPO_URL}/${String(path).replace(/^\/+/, "")}` : REPO_URL);
