// The /openapi.json MPP offers and the live 402's tempo challenge must read ONE
// predicate. The discovery doc once offered tempo on every paid route while the
// 402 withheld it on identity-bound and long-running routes, so a crawler and
// an agent budgeting from the document were promised a method that was refused.
import { readFileSync } from "node:fs";
import { tempoOfferedFor } from "../src/mpp-tempo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

ok(tempoOfferedFor({ priceUsd: 0.001 }) === true, "an ordinary priced route is offered tempo");
ok(tempoOfferedFor({ identityBound: true }) === false, "an identity-bound route is not offered tempo");
ok(tempoOfferedFor({ longRunning: true }) === false, "a long-running route is not offered tempo");
ok(tempoOfferedFor(null) === false, "an unpriced route is not offered tempo");

const tempoSrc = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
const pagesSrc = readFileSync(new URL("../src/pages.js", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/if \(tempoOfferedFor\(item\)\)/.test(tempoSrc), "the 402 appender decides with tempoOfferedFor");
const offersSrc = readFileSync(new URL("../src/mpp-offers.js", import.meta.url), "utf8");
ok(/mppOffersFor\(\{[^}]*identityBound: tool\.identityBound[^}]*longRunning: tool\.longRunning/.test(pagesSrc), "the discovery offers come from mppOffersFor with the route's own flags");
ok(/tempoOfferedFor\(item\) \? tempoDiscoveryInfo\(\)/.test(offersSrc), "the discovery offers decide with tempoOfferedFor");
ok(/stripe && !item\.identityBound/.test(offersSrc), "the discovery stripe offer is withheld on identity-bound routes, like the 402");
ok(/def\.quoteRange = \{ minUsd: floor, maxUsd: Number\.isFinite\(def\.quoteMaxUsd\) && def\.quoteMaxUsd >= floor \? def\.quoteMaxUsd : METERED_MAX_QUOTE_USD \}/.test(serverSrc), "quoted routes publish a range up to their own declared ceiling, else the metered cap");
ok(/typeof def\.tierQuote === "function"\) def\.quoteRange/.test(serverSrc), "priced-by-model routes publish a range");
ok(/amount: range \? null/.test(pagesSrc), "a ranged route's offers carry a null amount");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
