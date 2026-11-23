// A string input the handler caps by length says so in its published schema:
// `maxLength` on the field in discovery.inputSchema, the number the handler
// enforces. /openapi.json, the MCP tool list and the tool pages are built
// from that schema, so a caller can size a value before paying for a 400.
//
// The caps are MEASURED, not listed: every kit tool's handler is called
// offline with runs of letters (scripts/lib/input-caps.js). The suite fails
// when
//   - a handler caps a field and the schema declares no maxLength,
//   - a declared maxLength is not the handler's cap (a value that long is
//     refused, or one letter longer is accepted),
//   - a declared maxLength is shorter than a value the handler takes: a
//     longer value of another form goes through (a leading @, a second part
//     after a hyphen or a dot), or the "cap" is a set of words (the handler
//     takes a run of one letter and refuses another's: that field publishes
//     an `enum`),
//   - a published `enum` lists a member the handler refuses as it refuses a
//     value that is no member, or sits beside a maxLength shorter than one,
//   - a handler answers the long value with a 5xx BEFORE it reads anything
//     (a switch or a key gate in front of its checks hides the cap behind
//     it), unless the field is listed below with why,
//   - an entry of the short lists below no longer measures as it is described.
// Top-level string fields are read; a field inside an array or an object is
// described in its own text.
//
// The verdict is the same whatever the caller exports: the suite pins its own
// configuration before the first kit loads (the example cost table and a
// placeholder for every key a kit gates on, scripts/lib/input-caps.js), so a
// handler reaches its input checks here whether or not the shell or the CI
// job carries a cost table or a key. Nothing leaves the process.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { kitTools, goOffline, stringFields, measuredCap, declaredCapHolds, refusedMembers, pinConfiguration, readUpstream, outcomeOf, LONG } from "./lib/input-caps.js";

pinConfiguration();

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// Limits the measurement finds that are not a cap on the one field, each with
// why: the schema declares no maxLength for them.
const SHARED = "the limit is on the request's whole input, shared with the messages beside it";
const FILE_NAME = "the limit counts the extension, which the tool adds to a name sent without one";
const IMAGE_BYTES = "the value is base64 image bytes: ten letters is where a decoded value is long enough to be read as an image, not a length limit";
const NOT_ONE_FIELD = new Map([
  // (The premium and metered tiers take more than the measurement's long
  // value in one field, so they read upstream with it and are not listed.)
  ...["nano", "auto", "", "pro"].flatMap((t) => { const tier = t ? `v1-chat-${t}` : "v1-chat"; return [[`${tier}-messages.system`, SHARED], [`${tier}-responses.instructions`, SHARED]]; }),
  ["docx-create.markdown", "the limit is on the text of every field together (its own cap is past it)"],
  ["xlsx-create.filename", FILE_NAME], ["docx-create.filename", FILE_NAME], ["pptx-create.filename", FILE_NAME],
  ["image-ocr.image", IMAGE_BYTES], ["image-dominant-color.image", IMAGE_BYTES], ["image-crop.image", IMAGE_BYTES],
  ["judge-long.state", "the limit is the price guard's on the whole request (its bytes at the cost table's rate against the route's price, answered 413): the example table's number here, not a length of this field"],
]);
// Fields whose handler answers the long value with a 5xx and no read: each
// with why no cap of the field's is hidden behind that answer.
// A tool that renders in a browser answers 503 once its input checks pass
// when the host has no browser (some CI lanes install none). That answer
// comes after the checks, so it hides no cap; it is accepted only with that
// message, and the field's own cap (in UTF-8 bytes, answered 413 before any
// browser starts) is stated in its description.
const BROWSER_GATED = new Set(["html-frames.html"]);
const browserMissing = (outcome) => /Browser unavailable/i.test(outcome);
const ANSWERS_BEFORE_READING = new Map([
  ["v1-chat-ox.model", "the tier's one model was withdrawn upstream, so every call is answered 503 whatever it sends"],
]);
// A cap that holds on a value no generated form makes: the longest value the
// handler takes, built here from the kit's own rule.
const LONGEST_FORM = new Map([
  ["fc-user-casts.username", `@${"a".repeat(63)}.${"a".repeat(63)}.eth`],
]);

const online = goOffline();
try {
  // ---- controls: the measurement on handlers written here ----------------------
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  const def = (props, handler, input = {}) => ({ slug: "t", discovery: { input, inputSchema: { properties: props } }, handler });
  const capped = def({ text: { type: "string" } }, async (i) => { if (typeof i.text !== "string" || !i.text) throw bad('"text" is required'); if (i.text.length > 50) throw bad(`"text" is ${i.text.length} characters; at most 50`); return {}; });
  const perEntry = def({ ids: { type: "string" } }, async (i) => { for (const x of String(i.ids || "").split(",")) if (x.trim().length > 12) throw bad('"id" too long'); return {}; });
  const formOnly = def({ address: { type: "string" } }, async (i) => { if (!/^0x[0-9a-f]{40}$/.test(String(i.address))) throw bad('"address" must be a 0x address'); return {}; });
  const uncapped = def({ note: { type: "string" } }, async () => ({}));
  const keyGated = def({ q: { type: "string" } }, async () => { throw Object.assign(new Error("not configured"), { statusCode: 503 }); });
  const byExample = def({ place: { type: "string" }, lat: { type: "number" } }, async (i) => { if (i.lat != null) return {}; if (String(i.place || "").length > 30) throw bad('"place" is too long'); if (!i.place) throw bad("a place or lat is required"); return {}; }, { lat: 1 });
  const twoForms = def({ ref: { type: "string" } }, async (i) => { const r = String(i.ref || ""); if (r.length > (r.startsWith("0x") ? 42 : 10)) throw bad('"ref" is too long'); return {}; }, { ref: "0xabc" });
  ok((await measuredCap(capped, "text")).cap === 50, "control: a handler that refuses a value past 50 characters measures a cap of 50");
  ok((await measuredCap(perEntry, "ids")).cap === null && /per entry/.test((await measuredCap(perEntry, "ids")).why), "control: a limit on each entry of a list is not a cap on the field");
  ok((await measuredCap(formOnly, "address")).cap === null && (await measuredCap(uncapped, "note")).cap === null, "control: a field refused for its form at every length, or never refused, has no cap");
  const gatedM = await measuredCap(keyGated, "q");
  const reader = def({ q: { type: "string" } }, async (i) => { await fetch(`https://upstream.test/?q=${i.q.length}`); return {}; });
  const readerM = await measuredCap(reader, "q");
  ok(gatedM.cap === undefined && !readUpstream(gatedM.outcome), "control: a handler that answers 5xx before reading its input gives no verdict, and is told apart: it read nothing");
  ok(readerM.cap === undefined && readUpstream(readerM.outcome), `control: a handler that reads upstream with the long value gives no verdict and is booked as a read (${readerM.outcome})`);
  const alone = await measuredCap(byExample, "place");
  ok(alone.cap === 30 && alone.alone === true, "control: a cap the published example hides (it locates by another field) is measured with the field sent alone");
  ok((await measuredCap(twoForms, "ref")).cap === null && /no one limit/.test((await measuredCap(twoForms, "ref")).why), "control: a limit the published example's own value meets at another length establishes no one cap");
  const v = async (n) => (await declaredCapHolds(capped, "text", n)).verdict;
  const words = def({ kind: { type: "string" } }, async (i) => { if (i.kind != null && !["a", "bb", "wide"].includes(String(i.kind))) throw bad('"kind" must be one of a, bb, wide'); return {}; });
  const signed = def({ user: { type: "string" } }, async (i) => { if (!/^[a-z]{1,15}$/.test(String(i.user).replace(/^@/, ""))) throw bad('"user" must be a name'); return {}; });
  const twoPart = def({ lang: { type: "string" } }, async (i) => { if (!/^[a-z]{2,8}(-[a-z]{2,8})?$/.test(String(i.lang))) throw bad('"lang" must be a language code'); return {}; });
  const w1 = await declaredCapHolds(words, "kind", 1);
  ok(w1.verdict === "holds" && w1.words.length > 0, `control: a set of words is told from a length: the one-letter "cap" holds for a run of a and the handler refuses another letter's run (${w1.words})`);
  ok((await refusedMembers(words, "kind", ["a", "bb", "wide"]))?.length === 0 && (await refusedMembers(words, "kind", ["a", "bb", "tall"]))?.join() === "tall" && (await refusedMembers(uncapped, "note", ["x"])) === null, "control: a published member the handler refuses is named; a handler that refuses no value gives none");
  ok(/longer value is taken: 16/.test((await declaredCapHolds(signed, "user", 15)).verdict) && (await declaredCapHolds(signed, "user", 16)).verdict === "holds" && (await declaredCapHolds(signed, "user", 17)).verdict === "refused at the cap", "control: a cap that leaves out a leading @ the handler strips is too short by one; the cap that counts it holds");
  ok(/longer value is taken/.test((await declaredCapHolds(twoPart, "lang", 8)).verdict) && (await declaredCapHolds(twoPart, "lang", 17)).verdict === "holds" && (await declaredCapHolds(twoPart, "lang", 18)).verdict === "refused at the cap", "control: a cap on the first part of a two-part value is too short; the whole value's cap holds");
  ok((await v(50)) === "holds" && (await v(49)) === "accepted past the cap" && (await v(51)) === "refused at the cap" && (await declaredCapHolds(uncapped, "note", 10)).verdict === "not refused" && (await declaredCapHolds(byExample, "place", 30)).verdict === "holds", "control: a declared cap holds only at the handler's own number");

  // ---- every kit tool -----------------------------------------------------------
  const tools = await kitTools();
  const missing = [], wrong = [], malformed = [], unverified = [], staleExempt = [], declaredExempt = [], wordSets = [], badMembers = [], silent = [];
  let enums = 0, members = 0;
  const witnessSeen = new Set(), silentSeen = new Set();
  const verified = new Set(); // schema property objects whose cap held on some tool (a property shared by several tools)
  let fields = 0, declared = 0, noVerdict = 0;
  const exemptSeen = new Set();
  for (const tool of tools.values()) {
    for (const { name, schema } of stringFields(tool)) {
      fields++;
      const key = `${tool.slug}.${name}`;
      if (Array.isArray(schema.enum)) {
        const listed = schema.enum.filter((x) => typeof x === "string");
        enums++; members += listed.length;
        const refused = await refusedMembers(tool, name, listed);
        if (refused?.length) badMembers.push(`${key} refuses its published ${refused.map((x) => JSON.stringify(x)).join(", ")}`);
        const longest = Math.max(0, ...listed.map((x) => x.length));
        if (schema.maxLength !== undefined && schema.maxLength < longest) badMembers.push(`${key} declares maxLength ${schema.maxLength} beside a member ${longest} long`);
      }
      // A published enum is the field's limit: its length is not measured.
      if (Array.isArray(schema.enum) && schema.maxLength === undefined) continue;
      if (schema.maxLength !== undefined) {
        declared++;
        if (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength >= LONG) { malformed.push(`${key} (${schema.maxLength})`); continue; }
        if (NOT_ONE_FIELD.has(key)) { declaredExempt.push(key); continue; }
        if (LONGEST_FORM.has(key)) witnessSeen.add(key);
        const r = await declaredCapHolds(tool, name, schema.maxLength, { witness: LONGEST_FORM.get(key) });
        if (r.verdict === "holds") {
          verified.add(schema);
          if (r.words.length && !schema.enum && !schema.pattern) wordSets.push(`${key} (maxLength ${schema.maxLength}; a run of ${r.words.join(", ")} is refused where a run of a is taken)`);
        } else unverified.push({ key, schema, why: `${r.verdict} (${schema.maxLength})` });
        continue;
      }
      const m = await measuredCap(tool, name);
      if (m.cap === undefined) { noVerdict++; silent.push({ key, outcome: m.outcome }); }
      if (NOT_ONE_FIELD.has(key)) { exemptSeen.add(key); if (!Number.isInteger(m.cap)) staleExempt.push(`${key} (${m.why})`); continue; }
      if (Number.isInteger(m.cap)) missing.push(`${key} (handler caps it at ${m.cap})`);
    }
  }
  for (const u of unverified) if (!verified.has(u.schema)) wrong.push(`${u.key}: ${u.why}`);
  for (const key of NOT_ONE_FIELD.keys()) if (!exemptSeen.has(key) && !declaredExempt.includes(key)) staleExempt.push(`${key} (no such field)`);
  // Read last: an answer is booked as an upstream read when any call of the
  // run that gave it tried one (a breaker answers later calls with no read).
  const gated = [];
  for (const { key, outcome } of silent) {
    if (readUpstream(outcome)) continue;
    silentSeen.add(key);
    if (!ANSWERS_BEFORE_READING.has(key) && !(BROWSER_GATED.has(key) && browserMissing(outcome))) gated.push(`${key} (${outcome.slice(0, 70)})`);
  }
  const staleSilent = [...ANSWERS_BEFORE_READING.keys()].filter((k) => !silentSeen.has(k));
  const staleWitness = [...LONGEST_FORM.keys()].filter((k) => !witnessSeen.has(k));
  const costs = await import("../src/upstream-costs.js");
  ok(costs.upstreamCostsLoaded() && /example-upstream-costs\.json$/.test(process.env.UPSTREAM_COSTS_FILE) && !process.env.UPSTREAM_COSTS_JSON, "the measurement runs on the example cost table, whatever table the caller exported");
  ok(gated.length === 0 && staleSilent.length === 0, `no handler answers the long value with a 5xx before it reads its input or an upstream: a gate there hides the cap behind it (${[...gated, ...staleSilent.map((k) => `${k} is listed and no longer answers that way`)].slice(0, 12).join("; ") || `${noVerdict - silentSeen.size} fields read upstream with it, ${ANSWERS_BEFORE_READING.size} listed with why`})`);
  ok(wordSets.length === 0, `no declared maxLength is a set of words read as a length: such a field publishes enum (${wordSets.join("; ") || "none"})`);
  ok(badMembers.length === 0 && enums >= 40, `every member of a published enum is taken by its handler and fits any maxLength beside it (${badMembers.slice(0, 12).join("; ") || `${members} members of ${enums} enums`})`);
  ok(staleWitness.length === 0, `each longest form listed is still that field's (${staleWitness.join("; ") || `${LONGEST_FORM.size} listed`})`);
  ok(tools.size > 400 && fields > 800, `every kit tool's top-level string fields are read (${fields} fields of ${tools.size} tools; ${noVerdict} give no verdict offline)`);
  ok(missing.length === 0, `every field a handler caps by length declares maxLength in its published schema (${missing.slice(0, 12).join("; ") || "none missing"}${missing.length > 12 ? `; and ${missing.length - 12} more` : ""})`);
  ok(wrong.length === 0 && malformed.length === 0, `every declared maxLength is the handler's own cap: that many characters are taken, one more is refused (${[...wrong, ...malformed].slice(0, 12).join("; ") || "all hold"})`);
  ok(staleExempt.length === 0 && declaredExempt.length === 0, `each limit listed as not one field's length still measures that way and declares no maxLength (${[...staleExempt, ...declaredExempt].join("; ") || `${NOT_ONE_FIELD.size} listed`})`);
  ok(declared >= 200, `the published schemas declare ${declared} length caps`);
  // The fields the finding named.
  const la = tools.get("linkedin-article")?.discovery.inputSchema.properties || {};
  ok(la.tone?.maxLength === 80 && la.topic?.maxLength === 600 && la.angle?.maxLength === 400 && la.audience?.maxLength === 200 && la.cta?.maxLength === 200, `linkedin-article publishes each text field's cap (tone ${la.tone?.maxLength}, topic ${la.topic?.maxLength}, angle ${la.angle?.maxLength}, audience ${la.audience?.maxLength}, cta ${la.cta?.maxLength})`);
  // The closed sets and the caps the review named: each kit's own set or rule
  // against what its schema publishes, member by member.
  {
    const fits = (schema, value) => (!schema?.enum || schema.enum.includes(value)) && (schema?.maxLength === undefined || value.length <= schema.maxLength);
    const taken = async (slug, field, value, alone = false) => !/^4\d\d:/.test(await outcomeOf(tools.get(slug), field, value, alone));
    const prop = (slug, field) => tools.get(slug)?.discovery.inputSchema.properties[field];
    const { SUPPORTED } = await import("../src/tools/dns.js");
    const { SUPPORTED_FREQ } = await import("../src/tools/us-macro-series.js");
    const FRED_FREQ = new Set([...SUPPORTED_FREQ, "wef"]); // the codes fred-series' sources take
    const { LANG_RE } = await import("../src/tools/llm-context-kit.js");
    const { VIDEOS_MAX_PROMPT_CHARS } = await import("../src/tools/llm-images-fast-kit.js");
    const each = async (slug, field, values) => { const out = []; for (const x of values) if (!fits(prop(slug, field), x) || !(await taken(slug, field, x))) out.push(x); return out; };
    const dnsOut = await each("dns", "type", SUPPORTED), freqOut = await each("fred-series", "frequency", [...FRED_FREQ]);
    ok(SUPPORTED.includes("CNAME") && dnsOut.length === 0 && prop("dns", "type").maxLength === undefined && !fits(prop("dns", "type"), "SRV") && !(await taken("dns", "type", "SRV")), `dns.type publishes the handler's own record types and each one is taken (${dnsOut.join(", ") || SUPPORTED.join(", ")})`);
    ok(FRED_FREQ.has("wef") && freqOut.length === 0 && prop("fred-series", "frequency").maxLength === undefined && !fits(prop("fred-series", "frequency"), "zz") && !(await taken("fred-series", "frequency", "zz")), `fred-series.frequency publishes every frequency the handler takes and each one is taken (${freqOut.join(", ") || [...FRED_FREQ].join(", ")})`);
    const langs = ["en", "en-gb", "abcdefgh", "abcdefgh-abcdefgh", "zh-hant"], langOut = await each("llm-context", "lang", langs);
    ok(langs.every((x) => LANG_RE.test(x)) && langOut.length === 0 && prop("llm-context", "lang").maxLength === 17 && !LANG_RE.test("abcdefgh-abcdefghi"), `llm-context.lang's cap is the longest code its rule takes (${langOut.join(", ") || "17: two parts of eight and the hyphen"})`);
    const xName = `@${"a".repeat(15)}`;
    ok(fits(prop("x-user", "username"), xName) && (await taken("x-user", "username", xName)) && fits(prop("x-user-tweets", "username"), xName) && (await taken("x-user-tweets", "username", xName, true)), "an X username's cap counts the leading @ the handler takes");
    const fcName = LONGEST_FORM.get("fc-user-casts.username");
    ok(fits(prop("fc-user-casts", "username"), fcName) && (await taken("fc-user-casts", "username", fcName, true)) && !fits(prop("fc-user-casts", "username"), `${fcName}x`), `a Farcaster username's cap is the longest ENS name the handler takes behind an @ (${fcName.length})`);
    ok(prop("v1-videos", "prompt").maxLength === VIDEOS_MAX_PROMPT_CHARS && prop("judge", "state").maxLength === 8000 && prop("decisions", "input").maxLength === 8000, `the caps a key gate hid are published (v1-videos.prompt ${prop("v1-videos", "prompt").maxLength}, judge.state ${prop("judge", "state").maxLength}, decisions.input ${prop("decisions", "input").maxLength})`);
  }
  // /openapi.json carries the cap and the closed set for both request shapes:
  // a query parameter of a GET route and a property of a JSON body.
  {
    const { openapiSpec } = await import("../src/pages.js");
    const mk = (route, slug) => ({ route, slug, name: slug, category: "test", price: "$0.001", description: "A test tool.", tags: ["test"], discovery: { input: { q: "x" }, inputSchema: { properties: { q: { type: "string", maxLength: 64, description: "Query" }, n: { type: "number", description: "Count" }, free: { type: "string", description: "No cap" }, kind: { type: "string", enum: ["a", "bb", "wide"], description: "One of a set" } }, required: ["q"] }, output: { example: { ok: true } } }, handler: async () => ({ ok: true }) });
    const spec = openapiSpec("https://spec.test", { "GET /api/cap-get": mk("GET /api/cap-get", "cap-get"), "POST /api/cap-post": mk("POST /api/cap-post", "cap-post") });
    const params = spec.paths?.["/api/cap-get"]?.get?.parameters || [];
    const q = params.find((x) => x.name === "q"), n = params.find((x) => x.name === "n"), free = params.find((x) => x.name === "free");
    const body = spec.paths?.["/api/cap-post"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties || {};
    ok(q?.schema?.maxLength === 64 && q.schema.type === "string" && !("maxLength" in (n?.schema || {})) && !("maxLength" in (free?.schema || {})), `a GET route's query parameter carries the field's maxLength in /openapi.json (${JSON.stringify(q?.schema)})`);
    ok(body.q?.maxLength === 64 && !("maxLength" in (body.free || {})), `a JSON body's property carries it too (${JSON.stringify(body.q)})`);
    const kind = params.find((x) => x.name === "kind");
    ok(kind?.schema?.enum?.join() === "a,bb,wide" && kind.schema.type === "string" && !("enum" in (q?.schema || {})) && !("enum" in (free?.schema || {})) && body.kind?.enum?.join() === "a,bb,wide", `a field's closed set (enum) is on the GET route's query parameter and on the JSON body's property (${JSON.stringify(kind?.schema)})`);
  }
} finally { online(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
