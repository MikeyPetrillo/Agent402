// The three GPT Image tiers (src/tools/image-gen-kit.js), offline with a stub
// fetch. Pins what each tier actually sends upstream, so a tier cannot quietly
// become a relabelled copy of another (image-gen-premium sent the hd tier's
// exact request, at three times the price, until 2026-09-29), the premium
// orientation input, the per-tier upstream timeout, and that the published
// examples say what the handler returns.
//
//   node scripts/test-image-gen-kit.js
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
const { IMAGE_GEN_TOOLS, TIERS } = await import("../src/tools/image-gen-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (s) => IMAGE_GEN_TOOLS.find((t) => t.slug === s);
const priceOf = (s) => Number(bySlug(s).price.replace("$", ""));

let sent = [];
let usage = { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 100 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body, timeoutSignal: init.signal });
  return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
};
const call = async (slug, input) => { sent = []; const out = await bySlug(slug).handler(input); return { out, req: sent[0]?.body }; };
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

  // ---- published copy says what the handler does ----
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
