// Who runs an origin, for the politeness budgets that count per operator
// rather than per origin: the crawl's per-cycle cap (src/x402-index.js) and
// the per-host daily request budget (src/seller-load.js). A leaf module so
// both can import it without a cycle.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

// Registrable domain: the public suffix plus one label, from the ICANN section
// of the Public Suffix List, vendored in src/generated/public-suffixes.json by
// scripts/gen-public-suffixes.js (read once at import, never fetched). A seller
// under a country registry's second level (shop.co.za, shop.com.tr) is its own
// operator, not the whole registry's. A suffix the table lacks falls back to the
// default rule (the last label), which groups wider than ideal until the table
// is regenerated; it never causes an origin to be skipped forever.
const SUFFIX_RULES = new Set();
const SUFFIX_WILDCARDS = new Set();
const SUFFIX_EXCEPTIONS = new Set();
for (const rule of JSON.parse(readFileSync(new URL("./generated/public-suffixes.json", import.meta.url), "utf8")).rules) {
  if (rule.startsWith("!")) SUFFIX_EXCEPTIONS.add(rule.slice(1));
  else if (rule.startsWith("*.")) SUFFIX_WILDCARDS.add(rule.slice(2));
  else SUFFIX_RULES.add(rule);
}

/** One spelling per host: lowercase, ASCII (punycode), one trailing dot dropped. */
export function normalizeHost(host) {
  let h = String(host).toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  // A URL's hostname is already ASCII; only another spelling needs converting.
  return /^[\x00-\x7f]*$/.test(h) ? h : domainToASCII(h) || h;
}

/** The registrable domain of a normalized host name, or the name itself when it is a suffix. */
export function registrableDomain(host) {
  // Walk the label boundaries from the left, so the first rule that matches
  // is the longest one. `start` is where the candidate suffix begins and
  // `prev` where the label before it begins (the registrable domain's start).
  let prev = -1;
  for (let start = 0; start < host.length; ) {
    const candidate = host.slice(start);
    const dot = host.indexOf(".", start);
    if (SUFFIX_EXCEPTIONS.has(candidate)) return candidate;
    if (SUFFIX_RULES.has(candidate) || (dot >= 0 && SUFFIX_WILDCARDS.has(host.slice(dot + 1)))) {
      return prev < 0 ? host : host.slice(prev);
    }
    if (dot < 0) return prev < 0 ? host : host.slice(prev);
    prev = start;
    start = dot + 1;
  }
  return host;
}

// Suffixes where the label BELOW the suffix is a different tenant, not a
// different host of one operator. Without these, "last two labels" made every
// Vercel seller one operator, every Workers seller one operator, and so on -
// they would then have shared a single per-cycle crawl budget, and an attacker
// could have registered throwaway origins under the same suffix to starve another
// seller's listing until its learned quote went stale (QUOTE_MAX_AGE_MS).
// This file already knew better in one place: railwayDeploymentOrigin exists
// precisely because unrelated sellers publish on *.up.railway.app.
export const SHARED_HOSTING_SUFFIXES = [
  "workers.dev", "vercel.app", "up.railway.app", "railway.app", "onrender.com",
  "fly.dev", "pages.dev", "netlify.app", "herokuapp.com", "replit.app",
  "repl.co", "chatgpt.site", "trycloudflare.com", "ngrok-free.app", "ngrok.app",
  "deno.dev", "glitch.me", "surge.sh", "web.app", "firebaseapp.com",
  "azurewebsites.net", "appspot.com", "cloudfunctions.net", "koyeb.app",
  "vercel.sh", "netlify.com", "render.com", "streamlit.app", "hf.space",
  // Added from a read of the index (2026-10-20): each of these carried three
  // or more hosts paying to distinct wallets, so the hosts are different
  // sellers. A suffix whose hosts all paid to one wallet is one operator and
  // stays grouped (the cap is what keeps one actor's many hostnames to one
  // budget), and a suffix whose hosts had no payTo at all is left as it is
  // until one does.
  "supabase.co", "run.app", "sslip.io", "deno.net", "duckdns.org",
  "ngrok-free.dev", "ngrok.dev", "ts.net",
  // Cloud and static hosts whose every hostname below the suffix is a
  // different customer (each is on the public suffix list): an API Gateway or
  // Lambda URL host, a CloudFront distribution, a GitHub or GitLab Pages site.
  // Grouped, unrelated sellers would share one day's request budget
  // (src/seller-load.js) and one seller's load would hold the others' crawls.
  "amazonaws.com", "on.aws", "cloudfront.net", "awsapprunner.com",
  "github.io", "gitlab.io", "modal.run", "ondigitalocean.app",
  "azurestaticapps.net", "azurecontainerapps.io", "azure-api.net",
  "pythonanywhere.com", "lovable.app", "fly.io", "vercel.run",
];
// Shared suffixes above whose names each point wherever their owner says
// (wildcard and dynamic DNS): one server can sit behind any number of them,
// each its own operator here. The crawl's requests to such a name are also
// counted per address it resolves to (src/seller-load.js takeAddressBudget),
// so those names share one day at one address.
export const OWNER_ADDRESSED_SUFFIXES = ["sslip.io", "duckdns.org"];
/** Does `origin`'s name sit under OWNER_ADDRESSED_SUFFIXES? */
export function addressSetByName(origin) {
  let host;
  try { host = normalizeHost(new URL(origin).hostname); } catch { return false; }
  return OWNER_ADDRESSED_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
}
export function operatorKey(origin) {
  let host;
  try { host = normalizeHost(new URL(origin).hostname); } catch { return normalizeHost(origin); }
  // An address literal has no registrable domain: the address is the operator.
  if (isIP(host) || host.startsWith("[")) return host;
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  // Multi-tenant hosting: the tenant is the whole hostname. Grouping two tenants
  // together is not a small inaccuracy - it hands them one budget and lets either
  // one crowd the other out.
  for (const suffix of SHARED_HOSTING_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return host;
  }
  return registrableDomain(parts.join("."));
}
