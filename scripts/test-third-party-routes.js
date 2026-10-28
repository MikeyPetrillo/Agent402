// Routes that buy from an outside seller with our wallet are sold for a
// wallet payment only (src/third-party-routes.js): prepaid credits and card
// payments are spent only on Agent402's own services. Checks the real catalog
// definitions carry the flag and that both card-funded gates receive it.
import { readFileSync } from "node:fs";
import { paysThirdParty } from "../src/third-party-routes.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

const { EXEC_TIERS, buildRouteExecuteTool } = await import("../src/tools/route-execute.js");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// route-execute: every tier is built by one function; the flag sits in it.
const re = src("tools/route-execute.js");
ok(EXEC_TIERS.length > 0 && typeof buildRouteExecuteTool === "function", "route-execute builds its tiers from one definition");
ok(/spendsOwnWallet: true,[\s\S]{0,200}paysThirdPartySeller: true,/.test(re), "route-execute's tier definition is flagged");
for (const [file, slug] of [["tools/seller-payability-kit.js", "seller-payability"], ["tools/decide-kit.js", "decide-execute"]]) {
  const s = src(file);
  const at = s.indexOf(`slug: "${slug}"`);
  ok(at > 0 && /paysThirdPartySeller: true,/.test(s.slice(at, at + 1200)), `${slug} is flagged`);
}
// The flight routes buy each answer from an outside seller with our wallet: flagged too.
{
  const fl = src("tools/flights-kit.js");
  for (const slug of ["flight-search", "flight-status"]) { const at = fl.indexOf(`slug: "${slug}"`); ok(at > 0 && /paysThirdPartySeller: true,/.test(fl.slice(at, at + 600)), `${slug} is flagged`); }
}
// Network gas is an ordinary cost of our own service, not a third-party purchase.
ok(!/paysThirdPartySeller/.test(src("tools/attest-kit.js")), "attest-kit.js is not flagged");

ok(paysThirdParty({ paysThirdPartySeller: true }) === true && paysThirdParty({ spendsOwnWallet: true }) === false && paysThirdParty(null) === false, "only the explicit flag counts");

// Both card-funded gates are handed the flag by the server.
const server = src("server.js");
ok(/identityBound: isIdentityBoundRoute\(def\), paysThirdParty: paysThirdParty\(def\) \} : null;\n    \},\n  \}\);/.test(server), "the Stripe card gate receives paysThirdParty");
ok(/slug: def\.slug, identityBound: isIdentityBoundRoute\(def\), paysThirdParty: paysThirdParty\(def\)/.test(server), "the credits gate receives paysThirdParty");
ok(/!item\.paysThirdParty && priceUsd >= STRIPE_MIN_USD/.test(src("mpp-stripe.js")), "the card challenge is not offered on a third-party route");

// Credits cannot reach an outside seller through decide's execution credit.
const decide = src("tools/decide-kit.js");
ok(/const cardFunded = req\?\.creditsSettling === true \|\| req\?\.stripeSettling === true;\n\s+const amount = cardFunded \? 0 :/.test(decide), "a decision paid with credits or a card mints no execution credit");
ok(!/by credits or card/.test(decide), "decide-execute's description no longer offers credits or a card");
// The surfaces that describe what a credits key pays read the same flag or name the exclusion.
const pages = src("pages.js");
ok(/tool\.identityBound \|\| paysThirdParty\(tool\) \? \[\] : \["a prepaid credits key"\]/.test(pages) && /paysThirdParty\(tool\) \? " It buys from an outside seller with our wallet/.test(pages), "tool pages do not offer credits on a third-party route");
ok(/the operations that buy from an outside seller/.test(pages), "openapi's credits scheme names the excluded operations");
ok(/except the ones that buy from an outside seller/.test(src("seo.js")), "llms.txt names the excluded routes");
const mcpHttp = src("mcp-http.js");
ok(/onSale: creditsSalesEnabled\(\)/.test(mcpHttp) && /the routes that buy from an outside seller/.test(mcpHttp), "payment.info reads the sales switch and names the excluded routes");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
