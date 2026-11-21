// asn-info reads Team Cymru's DNS zone. A host resolver that fails on that
// zone (SERVFAIL or a timeout, seen on CI runners) must not fail the call:
// the lookup is retried once through public resolvers. An authoritative
// "no such name" (ENOTFOUND, ENODATA) is an answer and is never retried.
import "./lib/offline-stores.js";
const { cymruTxt } = await import("../src/tools/network-kit2.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok - " + m); } else { fail++; console.error("FAIL - " + m); } };
const err = (code) => Object.assign(new Error(`query ${code}`), { code });
const REC = [["15169 | 8.8.8.0/24 | US | arin | 2023-12-28"]];

for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED"]) {
  let fb = 0;
  const r = await cymruTxt("8.8.8.8.origin.asn.cymru.com", { primary: async () => { throw err(code); }, fallback: async () => { fb++; return REC; } });
  ok(fb === 1 && r === REC, `${code} from the host resolver is retried once through public resolvers`);
}
for (const code of ["ENOTFOUND", "ENODATA"]) {
  let fb = 0, threw = null;
  try { await cymruTxt("x.origin.asn.cymru.com", { primary: async () => { throw err(code); }, fallback: async () => { fb++; return REC; } }); }
  catch (e) { threw = e.code; }
  ok(fb === 0 && threw === code, `${code} is an answer: no retry, the code reaches the handler`);
}
{
  let fb = 0;
  const r = await cymruTxt("ok", { primary: async () => REC, fallback: async () => { fb++; return []; } });
  ok(fb === 0 && r === REC, "a working host resolver is used alone");
}
{
  let threw = null;
  try { await cymruTxt("x", { primary: async () => { throw err("ESERVFAIL"); }, fallback: async () => { throw err("ETIMEOUT"); } }); }
  catch (e) { threw = e.code; }
  ok(threw === "ETIMEOUT", "both failing surfaces the fallback's error (the handler answers 502, uncharged)");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
