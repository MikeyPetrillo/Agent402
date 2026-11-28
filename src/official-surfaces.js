// The official packages and endpoints, one list for every surface.
//
// A reader choosing a package or a connector address needs a first-party
// answer to "which ones are published by the company that runs this service".
// The answer is this list: the site, the hosted connector, the source
// repository, the MCP Registry server name, and every package the repository
// publishes. The packages are not typed here. scripts/gen-official-surfaces.js
// reads the repository's package manifests and writes
// src/generated/official-packages.json (the image ships src/, not the package
// trees); scripts/test-official-surfaces.js fails when a published package is
// not on it. /company renders it, /.well-known/x402 carries it as `official`,
// and README.md holds the same section.
import { readFileSync } from "node:fs";
import { REPO_URL, REPO_NAMESPACE } from "./repo-link.js";
import { LEGAL_ENTITY_SENTENCE } from "./legal-entity.js";

// The publisher is named as each package manifest names its author: the
// legal entity and the name it does business as.
export const OFFICIAL_PUBLISHER = LEGAL_ENTITY_SENTENCE;
export const OFFICIAL_SITE = "https://agent402.tools";
export const OFFICIAL_CONNECTOR = `${OFFICIAL_SITE}/mcp`;
/** Where the list is shown to a person, and where it is served as data. */
export const OFFICIAL_PAGE_PATH = "/company#official";
export const OFFICIAL_DATA_PATH = "/.well-known/x402";
export const OFFICIAL_SENTENCE = `These are the official Agent402.tools packages and endpoints, published by ${OFFICIAL_PUBLISHER}.`;

const REGISTRIES = {
  npm: { label: "npm", url: (name) => `https://www.npmjs.com/package/${name}` },
  pypi: { label: "PyPI", url: (name) => `https://pypi.org/project/${name}/` },
};

let list = null;
function load() {
  if (list) return list;
  try {
    const j = JSON.parse(readFileSync(new URL("./generated/official-packages.json", import.meta.url), "utf8"));
    list = { mcpRegistryName: typeof j.mcpRegistryName === "string" ? j.mcpRegistryName : null, packages: Array.isArray(j.packages) ? j.packages.filter((p) => p && REGISTRIES[p.registry] && typeof p.name === "string") : [] };
  } catch {
    list = { mcpRegistryName: null, packages: [] };
  }
  return list;
}
/** Read the generated list again (the generator, after it writes the file). */
export function _resetOfficialPackages() { list = null; }

/** Every package the repository publishes: { name, registry, url, renamedTo? }. */
export function officialPackages() {
  return load().packages.map((p) => ({ name: p.name, registry: p.registry, url: REGISTRIES[p.registry].url(p.name), ...(p.renamedTo ? { renamedTo: p.renamedTo } : {}) }));
}

/** The list as data: the `official` block of the discovery manifest. */
export function officialSurfacesDocument() {
  const { mcpRegistryName } = load();
  return {
    statement: OFFICIAL_SENTENCE,
    publisher: OFFICIAL_PUBLISHER,
    site: OFFICIAL_SITE,
    hostedConnector: OFFICIAL_CONNECTOR,
    repository: REPO_URL,
    ...(mcpRegistryName ? { mcpRegistry: { name: mcpRegistryName } } : {}),
    packages: officialPackages(),
    page: `${OFFICIAL_SITE}${OFFICIAL_PAGE_PATH}`,
  };
}

// The rows a person reads, in one order for the page and the README: the
// endpoints, then each registry's current packages, then each registry's
// earlier names (a last release that installs its replacement; the README
// and the data only, never a page).
//
// A served page never prints the repository's account name as text (the
// source link is an href; scripts/test-static-pages.js). So on a page the
// source row is a labeled link, and a registry name in the repository
// account's namespace is left to the data and the README, which name the
// repository anyway; a name in the domain's own namespace is shown.
function rows({ page = false } = {}) {
  const { mcpRegistryName } = load();
  const pkgs = officialPackages();
  const showRegistryName = mcpRegistryName && !(page && mcpRegistryName.toLowerCase().startsWith(`${REPO_NAMESPACE.toLowerCase()}/`));
  const out = [
    { label: "Site", kind: "link", items: [{ text: OFFICIAL_SITE.replace(/^https:\/\//, ""), url: OFFICIAL_SITE }] },
    { label: "Hosted MCP connector", kind: "code", items: [{ text: OFFICIAL_CONNECTOR }] },
    { label: "Source", kind: "link", items: [{ text: page ? "GitHub repository" : REPO_URL.replace(/^https:\/\//, ""), url: REPO_URL }] },
    ...(showRegistryName ? [{ label: "MCP Registry name", kind: "code", items: [{ text: mcpRegistryName }] }] : []),
  ];
  for (const [key, { label }] of Object.entries(REGISTRIES)) {
    const mine = pkgs.filter((p) => p.registry === key);
    const now = mine.filter((p) => !p.renamedTo), earlier = mine.filter((p) => p.renamedTo);
    if (now.length) out.push({ label, kind: "code", items: now.map((p) => ({ text: p.name, url: p.url })) });
    // An earlier name is listed in the data and the README only: a page
    // prints the current names and says where the earlier ones are.
    if (earlier.length && !page) out.push({ label: `${label}, earlier names`, kind: "code", items: earlier.map((p) => ({ text: p.name, url: p.url, now: p.renamedTo })) });
  }
  return out;
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The list as table rows for a page: [label, html] pairs, design tokens only.
 *  A row of several names is a list (OFFICIAL_LIST_CSS: one line of names on a
 *  wide screen, one name per line on a phone). Earlier names are not on the
 *  page: OFFICIAL_EARLIER_NOTE_HTML says where they are listed. */
export function officialSurfacesRows() {
  const a = (url, inner) => `<a href="${escHtml(url)}" rel="noopener" style="color:var(--ink);">${inner}</a>`;
  const code = (t) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${escHtml(t)}</code>`;
  return rows({ page: true }).map(({ label, kind, items }) => {
    const cells = items.map((it) => { const inner = kind === "code" ? code(it.text) : escHtml(it.text); return it.url ? a(it.url, inner) : inner; });
    return [label, cells.length > 1 ? `<ul class="official-names">${cells.map((c) => `<li>${c}</li>`).join("")}</ul>` : cells[0]];
  });
}
/** The page's one clause about earlier package names, with the README link. */
export const OFFICIAL_EARLIER_NOTE_HTML = `Earlier package names are listed in the <a href="${REPO_URL}#official-packages-and-endpoints" rel="noopener" style="color:var(--ink);">README</a>.`;
export const OFFICIAL_LIST_CSS = `.official-names{list-style:none;margin:0;padding:0}.official-names li{display:inline}.official-names li:not(:last-child)::after{content:", "}
@media (max-width:600px){.official-names li{display:block;padding:2px 0}.official-names li:not(:last-child)::after{content:none}}`;

/** The list as the README section body (no heading), in markdown. */
export function officialSurfacesMarkdown() {
  const md = rows().map(({ label, kind, items }) => `- **${label}:** ${items.map((it) => {
    const inner = kind === "code" ? `\`${it.text}\`` : it.text;
    return `${it.url ? `[${inner}](${it.url})` : inner}${it.now ? ` (now \`${it.now}\`)` : ""}`;
  }).join(", ")}`);
  return [
    OFFICIAL_SENTENCE,
    "",
    ...md,
    "",
    `The same list is shown at [agent402.tools${OFFICIAL_PAGE_PATH}](${OFFICIAL_SITE}${OFFICIAL_PAGE_PATH}) and served as data in [${OFFICIAL_DATA_PATH}](${OFFICIAL_SITE}${OFFICIAL_DATA_PATH}) (field \`official\`).`,
  ].join("\n");
}
