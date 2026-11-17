// Who runs an origin, for the politeness budgets that count per operator
// rather than per origin: the crawl's per-cycle cap (src/x402-index.js) and
// the per-host daily request budget (src/seller-load.js). A leaf module so
// both can import it without a cycle.

// Registrable domain, approximately: the last two labels, plus a third for the
// common multi-part suffixes. It does not need to be a full public-suffix list -
// getting it wrong groups an operator slightly wider or narrower than ideal, and
// never causes an origin to be skipped forever.
const MULTI_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "com.br", "co.nz", "co.in", "com.cn", "com.mx"]);

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
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return OWNER_ADDRESSED_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
}
export function operatorKey(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return String(origin).toLowerCase(); }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  // Multi-tenant hosting: the tenant is the whole hostname. Grouping two tenants
  // together is not a small inaccuracy - it hands them one budget and lets either
  // one crowd the other out.
  for (const suffix of SHARED_HOSTING_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return host;
  }
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}
