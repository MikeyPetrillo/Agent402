#!/usr/bin/env node
// Offline tests for facilitator/access-policy.js: the open-mainnet startup
// warning and the constant-time bearer compare, plus that index.js wires both
// and that the module ships in the package and the image.
import { readFileSync } from "node:fs";
import { openFacilitatorWarning, tokenMatches } from "../facilitator/access-policy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const open = { network: "stellar:pubnet", authToken: "", allowedPayTo: [], allowOpen: false };
const w = openFacilitatorWarning(open);
ok(Array.isArray(w) && /OPEN MAINNET FACILITATOR/.test(w.join("\n")) && /FACILITATOR_ALLOW_OPEN=1/.test(w.join("\n")), "pubnet with no token and no allowlist warns, naming the acknowledgment switch");
ok(openFacilitatorWarning({ ...open, authToken: "t" }) === null, "a token gates it: no warning");
ok(openFacilitatorWarning({ ...open, allowedPayTo: ["GABC"] }) === null, "a payTo allowlist gates it: no warning");
ok(openFacilitatorWarning({ ...open, allowOpen: true }) === null, "FACILITATOR_ALLOW_OPEN=1 acknowledges it: no warning");
ok(openFacilitatorWarning({ ...open, network: "stellar:testnet" }) === null, "testnet stays permissive: no warning");

ok(tokenMatches("secret-token", "secret-token") === true, "equal tokens match");
ok(tokenMatches("secret-tokeN", "secret-token") === false, "one differing byte does not match");
ok(tokenMatches("secret-token-longer", "secret-token") === false && tokenMatches("secret", "secret-token") === false, "different lengths do not match (and do not throw)");
ok(tokenMatches("", "") === false && tokenMatches("x", "") === false, "an empty expected token never matches");
ok(tokenMatches(undefined, "t") === false, "a missing presented token does not match");

const idx = read("facilitator/index.js");
ok(/import \{ openFacilitatorWarning, tokenMatches \} from "\.\/access-policy\.js";/.test(idx), "index.js imports the policy module");
ok(/if \(!tokenMatches\(token, AUTH_TOKEN\)\) return res\.status\(401\)/.test(idx) && !/token !== AUTH_TOKEN/.test(idx), "requireAuth uses the constant-time compare");
ok(/openFacilitatorWarning\(\{[\s\S]*?allowOpen: process\.env\.FACILITATOR_ALLOW_OPEN === "1"/.test(idx) && /if \(openWarning\) console\.error\(/.test(idx), "startup runs the open-mainnet check");
ok(JSON.parse(read("facilitator/package.json")).files.includes("access-policy.js"), "access-policy.js is in the package files list");
ok(/COPY [^\n]*facilitator\/access-policy\.js/.test(read("Dockerfile.facilitator")), "access-policy.js is copied into the image");
ok(/FACILITATOR_ALLOW_OPEN/.test(read("facilitator/README.md")), "README documents FACILITATOR_ALLOW_OPEN");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
