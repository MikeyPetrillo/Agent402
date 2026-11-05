// The one site entity every page's structured data names. Every author,
// publisher, creator and provider is a reference to `${baseUrl}/#organization`
// (the site, named as it brands itself), and that entity declares the company
// that operates it (`${baseUrl}/#org`, defined in full on /company) as its
// parent. ledgerShell emits the entity on every page, so a reference always
// resolves inside the page that carries it.
import { REPO_URL } from "./repo-link.js";

export const SITE_ORG_NAME = "Agent402";
export const COMPANY_NAME = "Havok Holdings LLC";
export const COMPANY_URL = "https://havok.holdings";

export const siteOrgId = (baseUrl) => `${baseUrl}/#organization`;
export const companyOrgId = (baseUrl) => `${baseUrl}/#org`;
/** A reference to the site entity, for author/publisher/creator/provider. */
export const siteOrgRef = (baseUrl) => ({ "@id": siteOrgId(baseUrl) });

/** The site entity in full. `mpp: false` (a server that does not offer MPP) leaves MPP out of knowsAbout. */
export function siteOrgLd(baseUrl, { mpp = true } = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": siteOrgId(baseUrl),
    name: SITE_ORG_NAME,
    alternateName: ["Agent402.Tools", "Agent402 Tools", "agent402.tools"],
    url: baseUrl,
    knowsAbout: ["Agentic Finance", "AIFI", "x402", ...(mpp ? ["Machine Payments Protocol (MPP)"] : []), "agentic payments", "AI agents"],
    logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` },
    email: "mike@agent402.tools",
    parentOrganization: { "@type": "Organization", "@id": companyOrgId(baseUrl), name: COMPANY_NAME, url: COMPANY_URL },
    sameAs: [REPO_URL, "https://x.com/Agent402Tools", "https://www.npmjs.com/package/agent402-mcp", "https://www.npmjs.com/package/agent402-client", "https://www.npmjs.com/package/agent402-tollbooth", "https://pypi.org/project/agent402-langchain/"],
  };
}
