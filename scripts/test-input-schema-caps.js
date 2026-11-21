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
//   - an entry of the short list below (limits that are not one field's
//     length) no longer measures as it is described.
// Top-level string fields are read; a field inside an array or an object is
// described in its own text.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { kitTools, goOffline, stringFields, measuredCap, declaredCapHolds, LONG } from "./lib/input-caps.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// Limits the measurement finds that are not a cap on the one field, each with
// why: the schema declares no maxLength for them.
const SHARED = "the limit is on the request's whole input, shared with the messages beside it";
const FILE_NAME = "the limit counts the extension, which the tool adds to a name sent without one";
const IMAGE_BYTES = "the value is base64 image bytes: ten letters is where a decoded value is long enough to be read as an image, not a length limit";
const NOT_ONE_FIELD = new Map([
  ...["nano", "auto", "", "pro", "premium"].flatMap((t) => { const tier = t ? `v1-chat-${t}` : "v1-chat"; return [[`${tier}-messages.system`, SHARED], [`${tier}-responses.instructions`, SHARED]]; }),
  ["docx-create.markdown", "the limit is on the text of every field together (its own cap is past it)"],
  ["xlsx-create.filename", FILE_NAME], ["docx-create.filename", FILE_NAME], ["pptx-create.filename", FILE_NAME],
  ["image-ocr.image", IMAGE_BYTES], ["image-dominant-color.image", IMAGE_BYTES], ["image-crop.image", IMAGE_BYTES],
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
  ok((await measuredCap(keyGated, "q")).cap === undefined, "control: a handler that answers 5xx before reading its input gives no verdict");
  const alone = await measuredCap(byExample, "place");
  ok(alone.cap === 30 && alone.alone === true, "control: a cap the published example hides (it locates by another field) is measured with the field sent alone");
  ok((await measuredCap(twoForms, "ref")).cap === null && /no one limit/.test((await measuredCap(twoForms, "ref")).why), "control: a limit the published example's own value meets at another length establishes no one cap");
  const v = async (n) => (await declaredCapHolds(capped, "text", n)).verdict;
  ok((await v(50)) === "holds" && (await v(49)) === "accepted past the cap" && (await v(51)) === "refused at the cap" && (await declaredCapHolds(uncapped, "note", 10)).verdict === "not refused" && (await declaredCapHolds(byExample, "place", 30)).verdict === "holds", "control: a declared cap holds only at the handler's own number");

  // ---- every kit tool -----------------------------------------------------------
  const tools = await kitTools();
  const missing = [], wrong = [], malformed = [], unverified = [], staleExempt = [], declaredExempt = [];
  const verified = new Set(); // schema property objects whose cap held on some tool (a property shared by several tools)
  let fields = 0, declared = 0, noVerdict = 0;
  const exemptSeen = new Set();
  for (const tool of tools.values()) {
    for (const { name, schema } of stringFields(tool)) {
      fields++;
      const key = `${tool.slug}.${name}`;
      if (schema.maxLength !== undefined) {
        declared++;
        if (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength >= LONG) { malformed.push(`${key} (${schema.maxLength})`); continue; }
        if (NOT_ONE_FIELD.has(key)) { declaredExempt.push(key); continue; }
        const r = await declaredCapHolds(tool, name, schema.maxLength);
        if (r.verdict === "holds") verified.add(schema);
        else unverified.push({ key, schema, why: `${r.verdict} (${schema.maxLength})` });
        continue;
      }
      const m = await measuredCap(tool, name);
      if (m.cap === undefined) noVerdict++;
      if (NOT_ONE_FIELD.has(key)) { exemptSeen.add(key); if (!Number.isInteger(m.cap)) staleExempt.push(`${key} (${m.why})`); continue; }
      if (Number.isInteger(m.cap)) missing.push(`${key} (handler caps it at ${m.cap})`);
    }
  }
  for (const u of unverified) if (!verified.has(u.schema)) wrong.push(`${u.key}: ${u.why}`);
  for (const key of NOT_ONE_FIELD.keys()) if (!exemptSeen.has(key) && !declaredExempt.includes(key)) staleExempt.push(`${key} (no such field)`);
  ok(tools.size > 400 && fields > 800, `every kit tool's top-level string fields are read (${fields} fields of ${tools.size} tools; ${noVerdict} give no verdict offline)`);
  ok(missing.length === 0, `every field a handler caps by length declares maxLength in its published schema (${missing.slice(0, 12).join("; ") || "none missing"}${missing.length > 12 ? `; and ${missing.length - 12} more` : ""})`);
  ok(wrong.length === 0 && malformed.length === 0, `every declared maxLength is the handler's own cap: that many characters are taken, one more is refused (${[...wrong, ...malformed].slice(0, 12).join("; ") || "all hold"})`);
  ok(staleExempt.length === 0 && declaredExempt.length === 0, `each limit listed as not one field's length still measures that way and declares no maxLength (${[...staleExempt, ...declaredExempt].join("; ") || `${NOT_ONE_FIELD.size} listed`})`);
  ok(declared >= 200, `the published schemas declare ${declared} length caps`);
  // The fields the finding named.
  const la = tools.get("linkedin-article")?.discovery.inputSchema.properties || {};
  ok(la.tone?.maxLength === 80 && la.topic?.maxLength === 600 && la.angle?.maxLength === 400 && la.audience?.maxLength === 200 && la.cta?.maxLength === 200, `linkedin-article publishes each text field's cap (tone ${la.tone?.maxLength}, topic ${la.topic?.maxLength}, angle ${la.angle?.maxLength}, audience ${la.audience?.maxLength}, cta ${la.cta?.maxLength})`);
  // /openapi.json carries the cap for both request shapes: a query parameter
  // of a GET route and a property of a JSON body.
  {
    const { openapiSpec } = await import("../src/pages.js");
    const mk = (route, slug) => ({ route, slug, name: slug, category: "test", price: "$0.001", description: "A test tool.", tags: ["test"], discovery: { input: { q: "x" }, inputSchema: { properties: { q: { type: "string", maxLength: 64, description: "Query" }, n: { type: "number", description: "Count" }, free: { type: "string", description: "No cap" } }, required: ["q"] }, output: { example: { ok: true } } }, handler: async () => ({ ok: true }) });
    const spec = openapiSpec("https://spec.test", { "GET /api/cap-get": mk("GET /api/cap-get", "cap-get"), "POST /api/cap-post": mk("POST /api/cap-post", "cap-post") });
    const params = spec.paths?.["/api/cap-get"]?.get?.parameters || [];
    const q = params.find((x) => x.name === "q"), n = params.find((x) => x.name === "n"), free = params.find((x) => x.name === "free");
    const body = spec.paths?.["/api/cap-post"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties || {};
    ok(q?.schema?.maxLength === 64 && q.schema.type === "string" && !("maxLength" in (n?.schema || {})) && !("maxLength" in (free?.schema || {})), `a GET route's query parameter carries the field's maxLength in /openapi.json (${JSON.stringify(q?.schema)})`);
    ok(body.q?.maxLength === 64 && !("maxLength" in (body.free || {})), `a JSON body's property carries it too (${JSON.stringify(body.q)})`);
  }
} finally { online(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
