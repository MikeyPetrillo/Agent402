// tls-cert's own name lookup (src/tools/kit.js) answers like the address
// guard: a resolver that cannot answer (EAI_AGAIN and the other transient
// codes) is a retryable 503 attributed upstream, and a name that does not
// exist is the one neutral 400 a private address also gets. The built-in
// resolver is stubbed before the kit loads, so nothing leaves this process.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
// A single-label host is refused before any lookup, so a resolver that
// answers it with EAI_AGAIN (a runner's search domains) cannot turn it into
// a 503: the guard and favicon-grab give the neutral 400 on every machine.
{
  code = "EAI_AGAIN";
  const { assertPublicUrl } = await import("../src/tools/fetch-guard.js");
  const e = await assertPublicUrl("https://ftp/x").then(() => null, (err) => err);
  ok(e?.statusCode === 400 && e.message === UNRESOLVED_OR_PRIVATE, `a single-label host is the neutral 400 even while the resolver says EAI_AGAIN (${e?.statusCode} ${e?.message})`);
  const { ENRICH_TOOLS } = await import("../src/tools/enrich-kit.js");
  const fav = (ENRICH_TOOLS || []).find((x) => x.slug === "favicon-grab");
  const f = fav ? await fav.handler({ url: "ftp://example.com" }).then(() => null, (err) => err) : "missing";
  ok(f && f !== "missing" && f.statusCode === 400, `favicon-grab refuses a non-http scheme before any lookup (${f?.statusCode ?? f})`);
  // A scheme whose name has a dot would read as a dotted host once https:// is prefixed; the scheme check stops it first.
  const g = fav ? await fav.handler({ url: "s3.example://bucket/key" }).then(() => null, (err) => err) : "missing";
  ok(g && g !== "missing" && g.statusCode === 400 && /http\(s\)/.test(g.message), `favicon-grab refuses a dotted non-http scheme too (${g?.statusCode ?? g} ${g?.message ?? ""})`);
}
// The lookup itself is bounded: a resolver that never answers is the retryable 503 after DNS_LOOKUP_TIMEOUT_MS.
{
  dnsp.lookup = () => new Promise(() => {});
  syncBuiltinESMExports();
  process.env.DNS_LOOKUP_TIMEOUT_MS = "200";
  const { KIT: KIT2 } = await import("../src/tools/kit.js?hang");
  const t2 = KIT2.find((x) => x.slug === "tls-cert");
  const t0 = Date.now();
  const e = await t2.handler({ host: "example.com" }).then(() => null, (err) => err);
  ok(e?.statusCode === 503 && Date.now() - t0 < 3000, `a lookup that never answers is a 503 within the timeout (${e?.statusCode} after ${Date.now() - t0} ms)`);
  delete process.env.DNS_LOOKUP_TIMEOUT_MS;
}
console.log(`\ntest-tls-cert-lookup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
