// asn-info reads Team Cymru's DNS zone. A host resolver that fails on that
// zone (SERVFAIL or a timeout, seen on CI runners) must not fail the call:
// the lookup is retried once through public resolvers. An authoritative
// "no such name" (ENOTFOUND, ENODATA) is an answer and is never retried.
import "./lib/offline-stores.js";
const { cymruTxt, setCymruLookups, CYMRU_FALLBACK, NETWORK_TOOLS2, ASN_OWNER_LOOKUP_MS, CYMRU_HEDGE_MS } = await import("../src/tools/network-kit2.js");
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
// The hedge: a host resolver that never answers (no error, no answer) must
// not keep the public fallback from answering. The fallback starts once the
// host resolver has had CYMRU_HEDGE_MS, the first answer wins and the other
// lookup is canceled; a host resolver that answers first still wins.
{
  ok(Number.isFinite(CYMRU_HEDGE_MS) && CYMRU_HEDGE_MS > 0 && CYMRU_HEDGE_MS * 2 <= ASN_OWNER_LOOKUP_MS, `the fallback starts well inside the owner deadline (${CYMRU_HEDGE_MS} of ${ASN_OWNER_LOOKUP_MS} ms)`);
  const OWNER = [["15169 | US | arin | 2000-03-30 | GOOGLE, US"]];
  const asnTool = NETWORK_TOOLS2.find((d) => d.slug === "asn-info");
  const signals = [];
  const hang = (n, signal) => { signals.push(["primary", n, signal]); return new Promise(() => {}); };
  setCymruLookups({
    primary: (n, signal) => (n.endsWith(".origin.asn.cymru.com") ? Promise.resolve(REC) : hang(n, signal)),
    fallback: async (n, signal) => { signals.push(["fallback", n, signal]); await new Promise((r) => setTimeout(r, 5)); return OWNER; },
    hedgeMs: 20, ownerMs: 400,
  });
  try {
    const t0 = Date.now();
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    const ms = Date.now() - t0;
    ok(r.owner === "GOOGLE, US" && !("ownerUnavailable" in r) && ms < 400, `a host resolver that never answers the owner query: the fallback's answer is served inside the deadline (${r.owner}, ${ms} ms)`);
    const p = signals.find(([w]) => w === "primary");
    ok(p && p[2]?.aborted === true, "the host resolver's lookup that lost is canceled");
  } finally { setCymruLookups(null); }
  // A host resolver that answers before the hedge: the fallback is never asked.
  let fb = 0;
  const r1 = await cymruTxt("AS15169.asn.cymru.com", { primary: async () => OWNER, fallback: async () => { fb++; return []; }, hedgeMs: 50 });
  await new Promise((r) => setTimeout(r, 80));
  ok(r1 === OWNER && fb === 0, "a host resolver that answers in time is used alone, and the fallback never starts");
  // Both running: the host resolver answers first and wins; the fallback is canceled.
  let fbSignal = null;
  const r2 = await cymruTxt("AS15169.asn.cymru.com", {
    primary: () => new Promise((r) => setTimeout(r, 40, OWNER)),
    fallback: (n, signal) => { fbSignal = signal; return new Promise((r) => setTimeout(r, 400, [["late"]])); },
    hedgeMs: 5,
  });
  ok(r2 === OWNER && fbSignal?.aborted === true, "with both running, the first answer (the host resolver's) wins and the fallback is canceled");
  // The fallback fails while the host resolver is still running: its answer is waited for.
  const r3 = await cymruTxt("AS15169.asn.cymru.com", { primary: () => new Promise((r) => setTimeout(r, 40, OWNER)), fallback: async () => { throw err("ETIMEOUT"); }, hedgeMs: 5 });
  ok(r3 === OWNER, "a fallback resolver failure waits for the host resolver's answer");
  // An authoritative "no such name" from the fallback is an answer.
  let threw = null;
  try { await cymruTxt("AS0.asn.cymru.com", { primary: () => new Promise(() => {}), fallback: async () => { throw err("ENOTFOUND"); }, hedgeMs: 5 }); }
  catch (e) { threw = e.code; }
  ok(threw === "ENOTFOUND", "the fallback's ENOTFOUND is an answer, not waited past");
  // The caller's signal cancels both lookups.
  const ac = new AbortController();
  const seen = [];
  const p = cymruTxt("AS15169.asn.cymru.com", { primary: (n, s) => { seen.push(s); return new Promise(() => {}); }, fallback: (n, s) => { seen.push(s); return new Promise(() => {}); }, hedgeMs: 5, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  let code = null;
  try { await p; } catch (e) { code = e.code; }
  ok(code === "ECANCELLED" && seen.length === 2 && seen.every((s) => s.aborted), "the caller's signal ends the lookup and cancels both resolvers");
}
// An owner that could not be read names the query it could not read, so the
// corpus runner asks that same query again (and nothing else) to confirm.
{
  const asnTool = NETWORK_TOOLS2.find((d) => d.slug === "asn-info");
  setCymruLookups({ primary: async (n) => { if (n.endsWith(".origin.asn.cymru.com")) return REC; throw err("ESERVFAIL"); }, fallback: async () => { throw err("ETIMEOUT"); } });
  try {
    const r = await asnTool.handler({ ip: "8.8.8.8" });
    ok(r.ownerUnavailable === true && r.ownerLookup?.type === "TXT" && r.ownerLookup?.name === "AS15169.asn.cymru.com", `the unavailable owner names its query (${JSON.stringify(r.ownerLookup)})`);
    const { unmeasuredMarks, runnerConfirmsUnmeasured } = await import("./test-corpus.js");
    const marks = unmeasuredMarks(r);
    const owner = marks.find((m) => m.covers.includes("owner"));
    ok(owner?.lookup?.type === "TXT" && owner.lookup.name === "AS15169.asn.cymru.com", "the corpus runner reads the owner mark's query");
    const asked = [], hostReads = [];
    const failing = async (name, type) => { asked.push(`${type} ${name}`); throw err("ETIMEOUT"); };
    const c = await runnerConfirmsUnmeasured({ marks, slug: "asn-info", targetHost: null, resolve: failing, readFails: async (u) => { hostReads.push(u); return true; } });
    ok(c.confirmed === true && JSON.stringify(asked) === '["TXT AS15169.asn.cymru.com"]' && hostReads.length === 0, `the runner re-asks the named TXT query and reads no host (${asked.join(",")}; hosts read: ${hostReads.join(",") || "none"})`);
    const d = await runnerConfirmsUnmeasured({ marks, slug: "asn-info", targetHost: null, resolve: async () => [["15169 | US | arin | 2000-03-30 | GOOGLE, US"]], readFails: async (u) => { hostReads.push(u); return true; } });
    ok(d.confirmed === false && hostReads.length === 0, "the named query answers the runner: not confirmed, and still no host is read");
  } finally { setCymruLookups(null); }
}
// /privacy names the public resolvers the fallback sends a lookup through.
{
  const { privacyPage } = await import("../src/privacy.js");
  const html = String(typeof privacyPage === "function" ? privacyPage("https://example.test") : "");
  const para = (html.match(/<li>[^<]*<code>asn-info<\/code>[\s\S]*?<\/li>/) || [""])[0];
  ok(para.length > 0 && CYMRU_FALLBACK.every((ip) => para.includes(ip)) && /Team Cymru/.test(para) && /IP address/.test(para), `/privacy says where an asn-info lookup goes, naming each public resolver (${para.slice(0, 80)})`);
  // The resolver asks its servers in list order, the next only when the one before does not answer: the page says that, in that order.
  const at = CYMRU_FALLBACK.map((ip) => para.indexOf(ip));
  ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])) && /first, then/.test(para) && /each only if the one before it does not answer/.test(para.replace(/\s+/g, " ")) && !/sent once\s+through the public resolvers/.test(para), "/privacy names the resolvers in the order they are asked, each only if the one before does not answer");
}
ok(JSON.stringify([...CYMRU_FALLBACK]) === JSON.stringify(["8.8.8.8", "9.9.9.9", "1.1.1.1"]), "the default fallback is the three public resolvers");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
