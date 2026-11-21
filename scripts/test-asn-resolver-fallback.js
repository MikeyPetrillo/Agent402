// asn-info reads Team Cymru's DNS zone. A host resolver that fails on that
// zone (SERVFAIL or a timeout, seen on CI runners) must not fail the call:
// the lookup is retried once through public resolvers. An authoritative
// "no such name" (ENOTFOUND, ENODATA) is an answer and is never retried.
import "./lib/offline-stores.js";
const { cymruTxt, setCymruLookups, CYMRU_FALLBACK, NETWORK_TOOLS2, ASN_OWNER_LOOKUP_MS } = await import("../src/tools/network-kit2.js");
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

// The caller path: the asn-info handler itself goes through cymruTxt, so a
// failing host resolver is answered from the public fallback (both lookups).
{
  const asnTool = NETWORK_TOOLS2.find((d) => d.slug === "asn-info");
  const seen = [];
  setCymruLookups({
    primary: async (n) => { seen.push(["primary", n]); throw err("ESERVFAIL"); },
    fallback: async (n) => { seen.push(["fallback", n]); return n.endsWith(".origin.asn.cymru.com") ? REC : [["15169 | US | arin | 2000-03-30 | GOOGLE, US"]]; },
  });
  try {
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    ok(r.asn === "AS15169" && r.owner === "GOOGLE, US", `the handler answers from the fallback when the host resolver fails (${r.asn}, ${r.owner})`);
    ok(seen.filter(([w]) => w === "fallback").length === 2 && seen.every(([, n]) => n.endsWith(".asn.cymru.com")), "both handler lookups (origin and owner) went through the fallback, inside the Cymru zone only");
  } finally { setCymruLookups(null); }
}
// The owner lookup is the second query and only adds the name: it has a
// deadline of its own, so a resolver that never answers it cannot hold the
// call. Past it the answer goes out with the origin record, owner null, and a
// field that says the name could not be read.
{
  const asnTool = NETWORK_TOOLS2.find((d) => d.slug === "asn-info");
  ok(Number.isFinite(ASN_OWNER_LOOKUP_MS) && ASN_OWNER_LOOKUP_MS >= 1000 && ASN_OWNER_LOOKUP_MS <= 5000, `the owner lookup has a deadline of a few seconds (${ASN_OWNER_LOOKUP_MS} ms)`);
  let ownerAsked = 0;
  setCymruLookups({
    primary: async (n) => { if (n.endsWith(".origin.asn.cymru.com")) return REC; ownerAsked++; return new Promise(() => {}); },
    fallback: async () => { throw err("ETIMEOUT"); },
    ownerMs: 40,
  });
  try {
    let guardTimer;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(resolve, 5000, "held"); });
    const r = await Promise.race([asnTool.handler({ ip: "8.8.8.8" }), guard]);
    clearTimeout(guardTimer);
    ok(r !== "held", "an owner lookup that never answers does not hold the call");
    ok(r?.asn === "AS15169" && r.prefix === "8.8.8.0/24" && r.owner === null && r.ownerUnavailable === true && ownerAsked === 1, `the answer keeps the origin record, with owner null and ownerUnavailable (${JSON.stringify(r)})`);
  } finally { setCymruLookups(null); }
  // An owner lookup that answers in time is unchanged, and says nothing extra.
  setCymruLookups({ primary: async (n) => (n.endsWith(".origin.asn.cymru.com") ? REC : [["15169 | US | arin | 2000-03-30 | GOOGLE, US"]]), ownerMs: 40 });
  try {
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    ok(r.owner === "GOOGLE, US" && !("ownerUnavailable" in r), "an owner lookup that answers in time is served as before");
  } finally { setCymruLookups(null); }
  // A lookup that fails outright (both resolvers) also says the name could not be read.
  setCymruLookups({ primary: async (n) => { if (n.endsWith(".origin.asn.cymru.com")) return REC; throw err("ESERVFAIL"); }, fallback: async () => { throw err("ETIMEOUT"); } });
  try {
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    ok(r.owner === null && r.ownerUnavailable === true, "a failed owner lookup says so in a field");
  } finally { setCymruLookups(null); }
  // An AS with no name on record is an answer: owner null, nothing unavailable.
  setCymruLookups({ primary: async (n) => { if (n.endsWith(".origin.asn.cymru.com")) return REC; throw err("ENOTFOUND"); } });
  try {
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    ok(r.owner === null && !("ownerUnavailable" in r), "no name on record is an answer, not an unavailable lookup");
  } finally { setCymruLookups(null); }
}
// /privacy names the public resolvers the fallback sends a lookup through.
{
  const { privacyPage } = await import("../src/privacy.js");
  const html = String(typeof privacyPage === "function" ? privacyPage("https://example.test") : "");
  const para = (html.match(/<li>[^<]*<code>asn-info<\/code>[\s\S]*?<\/li>/) || [""])[0];
  ok(para.length > 0 && CYMRU_FALLBACK.every((ip) => para.includes(ip)) && /Team Cymru/.test(para) && /IP address/.test(para), `/privacy says where an asn-info lookup goes, naming each public resolver (${para.slice(0, 80)})`);
}
ok(JSON.stringify([...CYMRU_FALLBACK]) === JSON.stringify(["8.8.8.8", "9.9.9.9", "1.1.1.1"]), "the default fallback is the three public resolvers");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
