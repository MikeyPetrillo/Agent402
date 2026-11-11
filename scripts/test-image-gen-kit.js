// The three GPT Image tiers (src/tools/image-gen-kit.js), offline with a stub
// fetch. Pins what each tier actually sends upstream, so a tier cannot quietly
// become a relabelled copy of another (image-gen-premium sent the hd tier's
// exact request, at three times the price, until 2026-09-29), the premium
// orientation input, the per-tier upstream timeout, and that the published
// examples say what the handler returns.
//
//   node scripts/test-image-gen-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
const { IMAGE_GEN_TOOLS, TIERS, imageModerationStats, isModerationParamError } = await import("../src/tools/image-gen-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (s) => IMAGE_GEN_TOOLS.find((t) => t.slug === s);
const priceOf = (s) => Number(bySlug(s).price.replace("$", ""));

let sent = [];
let usage = { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 100 };
const realFetch = globalThis.fetch;
// A queue of upstream answers for the next requests ({ status, body }); empty
// = a served image. Each request takes one, so a test sees every retry.
let upstream = [];
const openAIError = (status, error) => ({ status, body: { error } });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body, timeoutSignal: init.signal });
  const next = upstream.shift();
  if (next) return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
};
const call = async (slug, input) => { sent = []; const out = await bySlug(slug).handler(input); return { out, req: sent[0]?.body }; };
const thrown = async (slug, input) => { sent = []; try { await bySlug(slug).handler(input); return null; } catch (e) { return e; } };
const rejects = async (fn, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && e.statusCode === 400 && String(e.message).includes(frag), `${m} (${e ? e.statusCode + " " + e.message.slice(0, 90) : "no throw"})`); };

try {
  // ---- each tier sends its own request ----
  const gen = await call("image-gen", { prompt: "apple" });
  const hd = await call("image-gen-hd", { prompt: "apple" });
  const prem = await call("image-gen-premium", { prompt: "apple" });
  ok(gen.req.model === "gpt-image-2" && gen.req.quality === "low" && gen.req.size === "1024x1024" && gen.req.n === 1, "image-gen: gpt-image-2, low, 1024x1024, n=1");
  ok(hd.req.quality === "medium" && hd.req.size === "1024x1024", "image-gen-hd: medium, 1024x1024");
  ok(prem.req.quality === "medium" && prem.req.size === "1536x1024", "image-gen-premium defaults to landscape 1536x1024");
  ok(JSON.stringify({ ...prem.req, prompt: 0 }) !== JSON.stringify({ ...hd.req, prompt: 0 }), "premium's upstream request differs from hd's (a premium that is hd under another name fails here)");
  const px = (s) => s.split("x").reduce((a, b) => a * Number(b), 1);
  ok(px(prem.req.size) > px(hd.req.size), "premium's default image carries more pixels than hd's");

  // ---- premium orientation ----
  ok((await call("image-gen-premium", { prompt: "a", orientation: "portrait" })).req.size === "1024x1536", "orientation portrait -> 1024x1536");
  ok((await call("image-gen-premium", { prompt: "a", orientation: "Square" })).req.size === "1024x1024", "orientation square (case-insensitive) -> 1024x1024");
  ok((await call("image-gen-premium", { prompt: "a", orientation: "landscape" })).out.size === "1536x1024", "the answer reports the size actually rendered");
  await rejects(() => call("image-gen-premium", { prompt: "a", orientation: "1792x1024" }), '"orientation" must be one of landscape, portrait, square', "an unknown orientation is a self-explaining 400");
  await rejects(() => call("image-gen-premium", { prompt: "a", orientation: "__proto__" }), '"orientation"', "a prototype key is not an orientation");
  await rejects(() => call("image-gen-hd", { prompt: "a", orientation: "landscape" }), "orientation", "hd offers no landscape: 400 rather than a silent square");
  ok((await call("image-gen-hd", { prompt: "a", orientation: "square" })).req.size === "1024x1024", "control: hd accepts its one size by name");
  ok(sent.length === 1, "control: a valid request reaches upstream exactly once");
  sent = [];
  try { await bySlug("image-gen-premium").handler({ prompt: "a", orientation: "wide" }); } catch {}
  ok(sent.length === 0, "a refused orientation never reaches upstream");

  // ---- prompt caps, unchanged ----
  await rejects(() => call("image-gen-premium", { prompt: "x".repeat(4001) }), "Prompt too long", "premium prompt cap 4000");
  ok((await call("image-gen-premium", { prompt: "x".repeat(4000) })).req.prompt.length === 4000, "control: a 4000-char prompt is served");

  // ---- timeouts: premium's larger render gets a longer upstream bound ----
  ok(TIERS["image-gen-premium"].timeoutMs > TIERS["image-gen-hd"].timeoutMs && TIERS["image-gen"].timeoutMs >= 60_000, "premium's upstream timeout exceeds hd's; none under 60 s");

  // ---- a call billed over its token bound is logged, and still served ----
  const warns = []; const cw = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  usage = { ...usage, output_tokens: TIERS["image-gen-premium"].outputTokenBound + 1 };
  const over = await call("image-gen-premium", { prompt: "a" });
  usage = { ...usage, output_tokens: 10 };
  await call("image-gen-premium", { prompt: "a" });
  console.warn = cw;
  ok(over.out.image && warns.length === 1 && /image-gen-premium .* billed above its bound/.test(warns[0]), "over-bound usage is logged once and the image is still returned");

  // ---- moderation: "low" by default, "auto" on request ----
  for (const t of IMAGE_GEN_TOOLS) ok((await call(t.slug, { prompt: "a" })).req.moderation === "low", `${t.slug}: sends moderation "low" by default`);
  ok((await call("image-gen", { prompt: "a", moderation: "auto" })).req.moderation === "auto", 'a caller\'s moderation "auto" is sent as "auto"');
  ok((await call("image-gen-hd", { prompt: "a", moderation: " LOW " })).req.moderation === "low", "moderation is read trimmed and case-insensitive");
  ok((await call("image-gen", { prompt: "a", moderation: null })).req.moderation === "low", "a null moderation is the default");
  for (const v of ["high", "none", 1, { toString: 5 }, ["auto"]]) {
    const e = await thrown("image-gen", { prompt: "a", moderation: v });
    ok(e?.statusCode === 400 && e.message.includes('"moderation" must be one of low, auto') && sent.length === 0, `moderation ${JSON.stringify(v)} is a 400 naming the field and values, never sent upstream (${e?.statusCode} ${e?.message?.slice(0, 60)})`);
  }

  // ---- a model that does not take the parameter: one retry without it ----
  {
    const before = imageModerationStats().sinceBoot;
    const warns = []; const cw = console.warn; console.warn = (...a) => warns.push(a.join(" "));
    upstream = [openAIError(400, { message: "Unknown parameter: 'moderation'.", type: "invalid_request_error", param: "moderation", code: "unknown_parameter" })];
    const r = await call("image-gen", { prompt: "a" });
    ok(r.out.image && sent.length === 2 && sent[0].body.moderation === "low" && !("moderation" in sent[1].body) && sent[1].body.prompt === "a" && sent[1].body.quality === "low",
      `an unknown-parameter 400 sends the same request once more without moderation and serves it (${sent.length} requests)`);
    upstream = [openAIError(400, { message: "Invalid value: 'low'. Supported values are: 'auto'.", type: "invalid_request_error", param: null, code: "invalid_value" })];
    upstream[0].body.error.message = "Invalid value for 'moderation': 'low'. Supported values are: 'auto'.";
    ok((await call("image-gen-hd", { prompt: "a" })).out.image && sent.length === 2 && !("moderation" in sent[1].body), "an invalid-value 400 quoting 'moderation' (no param field) also falls back once");
    // Both answers refuse the parameter: never a loop, the second answer is final.
    upstream = [openAIError(400, { message: "Unknown parameter: 'moderation'.", param: "moderation", code: "unknown_parameter" }), openAIError(400, { message: "Unknown parameter: 'moderation'.", param: "moderation", code: "unknown_parameter" })];
    const e = await thrown("image-gen", { prompt: "a" });
    ok(e?.statusCode === 400 && sent.length === 2, `a second refusal of the parameter is final: two requests, a 400 (${sent.length}, ${e?.statusCode})`);
    upstream = [];
    console.warn = cw;
    const after = imageModerationStats().sinceBoot;
    ok(after.unknownParamFallbacks - before.unknownParamFallbacks === 3, `each fallback is counted (${after.unknownParamFallbacks - before.unknownParamFallbacks})`);
    ok(warns.filter((w) => /refused the moderation parameter/.test(w)).length === 1, `one console line per boot, not per fallback (${warns.length})`);
    ok(after.calls.auto - before.calls.auto === 2, "a render served without the parameter counts under the provider default, auto");
    // Another 400 that names some other field is not a moderation fallback.
    upstream = [openAIError(400, { message: "Invalid value: 'x'.", param: "size", code: "invalid_value" })];
    const e2 = await thrown("image-gen", { prompt: "a" });
    ok(e2?.statusCode === 400 && sent.length === 1 && /OpenAI rejected the request/.test(e2.message), "a 400 about another field is not retried");
    upstream = [];
    ok(!isModerationParamError(400, { code: "moderation_blocked", param: "moderation", message: "x" }) && !isModerationParamError(500, { param: "moderation" }) && isModerationParamError(400, { param: "moderation" }), "the fallback test reads 400 + the parameter, and never a content refusal");
  }

  // ---- a content-check refusal: 400, plain message, no retry, counted ----
  {
    const before = imageModerationStats().sinceBoot;
    const secret = "sk-proj-" + "A".repeat(40);
    upstream = [openAIError(400, { message: `Your request was rejected by the safety system. If you believe this is an error, contact us and include the request ID req_123. safety_violations=[violence]. ${secret}`, type: "image_generation_user_error", param: null, code: "moderation_blocked" })];
    const e = await thrown("image-gen-premium", { prompt: "a" });
    ok(e?.statusCode === 400 && sent.length === 1, `a refusal is a 400 and is not retried (${e?.statusCode}, ${sent.length} requests)`);
    ok(/^The model's content check refused this prompt\. Nothing was charged; rephrase the prompt and try again\./.test(e?.message || "") && /Flagged: violence\./.test(e.message) && !/"auto"/.test(e.message), `refusal message is plain and names what was flagged (${e?.message})`);
    ok(!e.message.includes(secret) && !e.message.includes("req_123"), "the upstream body is not echoed (no key, no request id)");
    upstream = [openAIError(400, { message: "Your request was rejected as a result of our safety system.", type: "invalid_request_error", param: null, code: "content_policy_violation" })];
    const e2 = await thrown("image-gen", { prompt: "a", moderation: "auto" });
    ok(e2?.statusCode === 400 && sent.length === 1 && sent[0].body.moderation === "auto" && /This call used moderation "auto"; "low", the default, filters less strictly\./.test(e2.message), `a "safety system" message on an auto call: 400, no retry, and says low is the default (${e2?.message})`);
    // Never routed elsewhere: every request in the refusal went to the one images endpoint and model.
    ok(sent.every((x) => new URL(x.url).pathname === "/v1/images/generations" && x.body.model === "gpt-image-2"), "a refused prompt goes to no other model or endpoint");
    upstream = [];
    const after = imageModerationStats().sinceBoot;
    ok(after.refusals.low - before.refusals.low === 1 && after.refusals.auto - before.refusals.auto === 1, `refusals are counted by level (${JSON.stringify(after.refusals)})`);
    ok(JSON.stringify(imageModerationStats()).length < 200 && !/apple|violence/.test(JSON.stringify(imageModerationStats())), "the counters hold counts only, no prompt or category text");
  }

  // ---- published copy says what the handler does ----
  for (const t of IMAGE_GEN_TOOLS) {
    const p = t.discovery.inputSchema.properties.moderation;
    ok(p?.enum?.join() === "low,auto" && /usage policies/.test(p.description) && /"low"/.test(t.description) && /usage policies still apply/.test(t.description), `${t.slug}: schema and description name moderation, its default and the provider's usage policies`);
  }
  const pd = bySlug("image-gen-premium");
  ok(pd.discovery.output.example.size === "1536x1024" && pd.discovery.inputSchema.properties.orientation?.enum?.join() === "landscape,portrait,square", "premium example + schema match the handler (landscape default, three orientations)");
  ok(/1536x1024/.test(pd.description) && /1024x1536/.test(pd.description) && !/best detail|flagship/i.test(pd.description), "premium description names its sizes and makes no unscoped superlative");
  ok(priceOf("image-gen") < priceOf("image-gen-hd") && priceOf("image-gen-hd") < priceOf("image-gen-premium"), "the ladder rises with what each tier delivers");
  ok(IMAGE_GEN_TOOLS.every((t) => !/—/.test(t.description + t.name)), "no em dashes in tool copy");
  for (const t of IMAGE_GEN_TOOLS) {
    const ex = t.discovery.output.example;
    const { out } = await call(t.slug, t.discovery.input);
    ok(Object.keys(ex).every((k) => k in out) && out.size === ex.size && out.quality === ex.quality, `${t.slug}: its own example input returns the documented keys, size and quality`);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\ntest-image-gen-kit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
