// Our own upstream caps (src/upstream-cap-refusals.js): every refusal is
// counted per cap and per slug, the public word reads "reached" for an hour
// after one, a cached answer or a call that never reaches the upstream is not
// counted by a cap, and a refused call is never charged on any rail.
//
//   node scripts/test-upstream-cap-refusals.js
//
// Part 1 is offline (the counter, the wrapper, each cap's mark and what it
// counts). Part 2 boots a PAID server (scripts/lib/paid-wires-rig.js, every
// rail stubbed, nothing leaves the machine) with the RDAP registry day cap at
// one, and pays whois on every rail that settles after the run, and with
// prepaid credits: each refusal is a 503 with no settle call, no balance
// moved and no credits debit, and the operator view and the word see it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

const caps = await import("../src/upstream-cap-refusals.js");
const { CAP_NAMES, noteCapRefusal, withCapRefusalCount, upstreamCapsWord, upstreamCapRefusals, __test } = caps;

// ---- 1. the counter, the word and the wrapper ------------------------------------
{
  __test.reset();
  let t = Date.parse("2026-11-23T12:00:00Z");
  __test.setClock(() => t);
  ok(upstreamCapsWord() === "ok", "no refusal: the word reads ok");
  const refuse = withCapRefusalCount("whois", async () => { throw Object.assign(new Error("cap"), { statusCode: 503, capRefusal: CAP_NAMES.rdapRegistryDay }); });
  const plain = withCapRefusalCount("whois", async () => { throw Object.assign(new Error("upstream"), { statusCode: 502 }); });
  const fine = withCapRefusalCount("whois", async (i) => ({ echo: i.x }));
  ok((await caught(refuse({})))?.statusCode === 503, "the wrapper rethrows the refusal as it came");
  await caught(plain({}));
  ok((await fine({ x: 1 })).echo === 1, "an answer passes through the wrapper untouched");
  const v = upstreamCapRefusals();
  ok(v.caps[CAP_NAMES.rdapRegistryDay].refused === 1 && v.caps[CAP_NAMES.rdapRegistryDay].bySlug.whois.refused === 1 && v.caps[CAP_NAMES.blsDay].refused === 0, `a cap refusal is counted under its cap and slug; another error is not (${JSON.stringify(v.caps[CAP_NAMES.rdapRegistryDay])})`);
  ok(upstreamCapsWord() === "reached" && v.word === "reached", "after a refusal the word reads reached");
  t += 59 * 60_000;
  ok(upstreamCapsWord() === "reached", "still reached inside the hour");
  t += 2 * 60_000;
  ok(upstreamCapsWord() === "ok", "an hour after the last refusal the word reads ok again");
  ok(noteCapRefusal("not-a-cap", "whois") === false, "an unknown cap name is not counted");
  ok(withCapRefusalCount("x", refuse) === refuse, "a handler is wrapped once");
  __test.reset();
}

// ---- 2. each cap marks its refusal, and counts only real reads --------------------
{
  // RDAP registry day cap: the refusal is marked; a paced refusal (nothing
  // sent) gives its place back and is not a cap refusal.
  const { createRegistryLimits } = await import("../src/tools/rdap-registry-limits.js");
  const lim = createRegistryLimits({ paceMs: 0, dailyMax: 2 });
  await lim.admit("rdap.example");
  await lim.admit("rdap.example");
  const e = await caught(lim.admit("rdap.example"));
  ok(e?.statusCode === 503 && e.capRefusal === CAP_NAMES.rdapRegistryDay && lim._count("rdap.example") === 2, "the registry day cap's refusal is marked, and a refused lookup is not counted as a read");
  const paced = createRegistryLimits({ paceMs: 10_000, dailyMax: 5 });
  await paced.admit("slow.example");
  const pe = await caught(paced.admit("slow.example"));
  ok(pe?.statusCode === 503 && !pe.capRefusal && paced._count("slow.example") === 1, "a paced refusal is not a cap refusal and gives its place in the day back");

  // domain-availability: a cached answer never reaches the registry, so it
  // takes no place in the day's count.
  const { createDomainAvailability } = await import("../src/tools/domain-availability-kit.js");
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    if (req.url === "/iana/dns.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ services: [[["test"], ["https://rdap-a.test/a/"]]] })); }
    res.writeHead(200, { "content-type": "application/rdap+json" });
    res.end(JSON.stringify({ objectClassName: "domain", ldhName: "taken.test", events: [{ eventAction: "registration", eventDate: "2001-01-01T00:00:00Z" }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  let sent = 0;
  const stubFetch = (url, init) => { const u = new URL(url); sent++; return fetch(`http://127.0.0.1:${port}${u.hostname === "data.iana.test" ? "/iana" : ""}${u.pathname}`, init); };
  const lim2 = createRegistryLimits({ paceMs: 0, dailyMax: 1 });
  const d = createDomainAvailability({ fetchImpl: stubFetch, bootstrapUrl: "https://data.iana.test/dns.json", limits: lim2 });
  try {
    const a = await d.check({ domain: "taken.test" });
    const before = sent;
    const b = await d.check({ domain: "taken.test" });
    ok(a.registered === true && b.registered === true && sent === before && lim2._count("rdap-a.test") === 1, `a cached domain-availability answer is not a read and takes no place under the cap (${lim2._count("rdap-a.test")})`);
    const c = await caught(d.check({ domain: "other.test" }));
    ok(c?.statusCode === 503 && c.capRefusal === CAP_NAMES.rdapRegistryDay, "the next real read past the cap is refused, marked");
  } finally { await new Promise((r) => srv.close(r)); }

  // BLS day budget: a decade held in the cache is not a query; the refusal past
  // the budget is marked.
  const um = await import("../src/tools/us-macro-series.js");
  const { stubGuardResolver, offlineGuardAnswer } = await import("./lib/guard-resolver-stub.js");
  const undo = stubGuardResolver(offlineGuardAnswer);
  const realFetch = globalThis.fetch;
  let blsQueries = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (new URL(String(url)).hostname !== "api.bls.gov") return new Response("no", { status: 599 });
    blsQueries++;
    const b = JSON.parse(opts.body);
    return new Response(JSON.stringify({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: b.seriesid[0], data: [{ year: b.startyear, period: "M01", value: "1" }] }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    um._resetUsMacroForTest();
    await um.usMacroSeries({ seriesId: "UNRATE", startDate: "2001-01-01", endDate: "2001-12-31" });
    await um.usMacroSeries({ seriesId: "UNRATE", startDate: "2002-01-01", endDate: "2003-12-31" });
    ok(blsQueries === 1, `a decade already held answers from the cache, with no query taken from the budget (${blsQueries})`);
    um._resetUsMacroForTest();
    for (let k = 0; k < um.blsDailyBudget(); k++) await um.usMacroSeries({ seriesId: ["UNRATE", "PAYEMS", "CPIAUCSL"][k % 3], startDate: `${1920 + 10 * Math.floor(k / 3)}-01-01`, endDate: `${1920 + 10 * Math.floor(k / 3)}-12-31` }).catch(() => {});
    const e2 = await caught(um.usMacroSeries({ seriesId: "U6RATE", startDate: "2010-01-01", endDate: "2010-12-31" }));
    ok(e2?.statusCode === 503 && e2.capRefusal === CAP_NAMES.blsDay, `the BLS day budget's refusal is marked (${e2?.statusCode})`);
  } finally { globalThis.fetch = realFetch; undo(); }

  // search-suggest: our ceiling's busy is marked; the source's own 429 is not ours.
  const ws = await import("../src/tools/wikipedia-suggest.js");
  let t = 5_000_000;
  ws._setSuggestClockForTest(() => t, async (ms) => { t += ms; });
  globalThis.fetch = async () => new Response(JSON.stringify(["a", ["A"]]), { status: 200, headers: { "content-type": "application/json" } });
  try {
    for (let k = 0; k < ws.SUGGEST_MAX_PER_MINUTE; k++) await ws.wikipediaSuggestions("a", 1);
    const e3 = await caught(ws.wikipediaSuggestions("a", 1));
    ok(e3?.statusCode === 503 && e3.capRefusal === CAP_NAMES.suggestRate, "search-suggest's per-minute ceiling marks its busy");
    t += 120_000;
    globalThis.fetch = async () => new Response("slow down", { status: 429 });
    const e4 = await caught(ws.wikipediaSuggestions("b", 1));
    ok(e4?.statusCode === 503 && !e4.capRefusal, "the source's own 429 is not counted as our cap");
  } finally { globalThis.fetch = realFetch; ws._setSuggestClockForTest(); }
}

// ---- 3. a refused call is never charged, on every rail -----------------------------
{
  const { bootPaidWires } = await import("./lib/paid-wires-rig.js");
  const credStores = mkdtempSync(join(tmpdir(), "a402-cap-refusals-credits-"));
  const CREDIT_KEY = `a402_${randomBytes(16).toString("hex")}`;
  const hashKey = (k) => createHash("sha256").update(k).digest("hex");
  const keyFile = join(credStores, `k_${hashKey(CREDIT_KEY)}.json`);
  writeFileSync(keyFile, JSON.stringify({ keyId: "kid_caps", balanceMicro: 5_000_000, loadedMicro: 5_000_000, spentMicro: 0, calls: 0, createdAt: new Date().toISOString(), pack: "credits-20", sessions: [], paymentIntents: [], lastUsedAt: null }));
  const rig = await bootPaidWires({ label: "cap-refusals", env: { RDAP_REGISTRY_DAILY_MAX: "1", CREDITS_DIR: credStores, STRIPE_SECRET_KEY: "sk_test_cap_refusals_never_used", STRIPE_PROFILE_ID: "profile_test_cap_refusals", STRIPE_WEBHOOK_SECRET: "", STRIPE_TOKEN_STUB: "on" } });
  try {
    const WHOIS = { path: "/api/whois", method: "POST", body: { domain: "example.com" } };
    // The first call takes the day's one place (its read cannot leave this
    // machine, so it fails, uncharged); every later one meets the cap.
    const first = await rig.pay(await rig.wallet("evm"), WHOIS);
    ok(first.status >= 400, `the call that takes the day's place answers ${first.status} offline`);
    const before = (await rig.operator("/__operator/upstream-caps.json"))?.caps?.[CAP_NAMES.rdapRegistryDay]?.refused || 0;
    for (const wire of ["evm", "mpp-evm", "tempo", "svm", "avm", "stellar"]) {
      const w = await rig.wallet(wire);
      rig.fund(w, 10n ** 9n);
      const settlesBefore = rig.st.settleAttempts;
      const r = await rig.pay(w, WHOIS);
      ok(r.status === 503 && /daily limit/.test(r.json?.error || r.text) && rig.st.settleAttempts === settlesBefore && rig.outcomesOf(w).settled === 0 && rig.accounts.get(w.id).balance === 10n ** 9n, `${wire}: the cap refusal answers 503 with no settle call and nothing taken (${r.status}, settles ${rig.st.settleAttempts - settlesBefore})`);
    }
    const balanceOf = () => JSON.parse(readFileSync(keyFile, "utf8")).balanceMicro;
    const b0 = balanceOf();
    const c = await rig.send(WHOIS, { authorization: `Bearer ${CREDIT_KEY}` });
    await new Promise((r) => setTimeout(r, 100));
    ok(c.status === 503 && balanceOf() === b0, `credits: the cap refusal answers 503 and debits nothing (${c.status})`);
    const view = await rig.operator("/__operator/upstream-caps.json");
    const n = view?.caps?.[CAP_NAMES.rdapRegistryDay]?.refused || 0;
    ok(n - before === 7 && view.caps[CAP_NAMES.rdapRegistryDay].bySlug.whois.refused >= 7, `the operator view counts each refusal under the cap and the slug (${n - before})`);
    const gs = await rig.gatewayStatus();
    ok(gs.upstreamCaps === "reached", `the public word reads reached (${gs.upstreamCaps})`);
    const anon = await fetch(`${rig.url}/__operator/upstream-caps.json`);
    ok(anon.status === 404, "the operator view is not served without the token");
  } finally { await rig.stop(); }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
