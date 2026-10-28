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
// A fixed upstream vendor or network gas is an ordinary cost, not a third-party purchase.
for (const file of ["tools/flights-kit.js", "tools/attest-kit.js"]) ok(!/paysThirdPartySeller/.test(src(file)), `${file.split("/").pop()} is not flagged`);

ok(paysThirdParty({ paysThirdPartySeller: true }) === true && paysThirdParty({ spendsOwnWallet: true }) === false && paysThirdParty(null) === false, "only the explicit flag counts");

// Both card-funded gates are handed the flag by the server.
const server = src("server.js");
ok(/identityBound: isIdentityBoundRoute\(def\), paysThirdParty: paysThirdParty\(def\) \} : null;\n    \},\n  \}\);/.test(server), "the Stripe card gate receives paysThirdParty");
ok(/slug: def\.slug, identityBound: isIdentityBoundRoute\(def\), paysThirdParty: paysThirdParty\(def\)/.test(server), "the credits gate receives paysThirdParty");
ok(/!item\.paysThirdParty && priceUsd >= STRIPE_MIN_USD/.test(src("mpp-stripe.js")), "the card challenge is not offered on a third-party route");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
