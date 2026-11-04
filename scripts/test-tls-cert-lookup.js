// tls-cert's own name lookup (src/tools/kit.js) answers like the address
// guard: a resolver that cannot answer (EAI_AGAIN and the other transient
// codes) is a retryable 503 attributed upstream, and a name that does not
// exist is the one neutral 400 a private address also gets. The built-in
// resolver is stubbed before the kit loads, so nothing leaves this process.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const dnsp = require("node:dns/promises");
let code = null;
dnsp.lookup = async () => { throw Object.assign(new Error(`stub ${code}`), { code }); };
syncBuiltinESMExports();
const { KIT } = await import("../src/tools/kit.js");
const { UNRESOLVED_OR_PRIVATE, LOOKUP_UNAVAILABLE } = await import("../src/tools/fetch-guard.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const t = KIT.find((x) => x.slug === "tls-cert");
const run = async (c) => { code = c; try { await t.handler({ host: "example.com" }); return null; } catch (e) { return e; } };

for (const c of ["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT"]) {
  const e = await run(c);
  ok(e?.statusCode === 503 && e.retryAfter > 0 && e.attribution === "upstream" && e.message === LOOKUP_UNAVAILABLE, `${c}: a retryable 503 attributed upstream (${e?.statusCode} ${e?.message})`);
}
for (const c of ["ENOTFOUND", "ENODATA"]) {
  const e = await run(c);
  ok(e?.statusCode === 400 && e.message === UNRESOLVED_OR_PRIVATE, `${c}: the neutral 400 (${e?.statusCode} ${e?.message})`);
}
console.log(`\ntest-tls-cert-lookup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
