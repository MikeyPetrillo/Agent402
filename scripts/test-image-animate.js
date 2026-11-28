// Image to video (`POST /api/image-animate`, src/tools/llm-images-fast-kit.js)
// - offline: the Video API is a stub on globalThis.fetch, the picture's URL is
// answered by an undici MockAgent behind the real SSRF dispatcher, and the
// guard's name lookups are stubbed (scripts/lib/guard-resolver-stub.js), so
// nothing leaves the process.
//
// Pins: the listing (slug, route, price, model-backed, wallet-only, slow and
// long-running, never settled first, its own private cost row in REQUIRED);
// the request the provider gets (the locked 4 s silent 720p clip on the video
// model, the picture as a first-frame data URL, the aspect from the picture
// unless set); base64, data: URL and https URL inputs; every refusal that
// needs no upstream (oversize, pixel bomb, second header, not PNG/JPEG, http,
// private address, a name that turns private at connect, a redirect to a
// private address, a compressed body past the cap) answers 4xx with no
// submit, so nothing is settled; the content filter answers 422
// content_filtered at submit and on a failed job, an outage stays 5xx; a
// timed-out call from a wallet payer is collected by the same request again.
//
//   node scripts/test-image-animate.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.VIDEOS_POLL_MS = "5";
process.env.VIDEOS_MAX_WAIT_MS = "1000";
process.env.OPENROUTER_API_KEY = "test-key";
import { createServer } from "node:http";
import { gzipSync, deflateSync, crc32 } from "node:zlib";
import { MockAgent, Dispatcher, Dispatcher1Wrapper } from "undici";
const K = await import("../src/tools/llm-images-fast-kit.js");
const { IMAGES_FAST_TOOLS, ANIMATE_PATH, ANIMATE_PRICE, ANIMATE_COST_KEY, ANIMATE_MAX_IMAGE_BYTES, ANIMATE_MAX_PIXELS, VIDEOS_MODEL, OPENROUTER_VIDEOS_URL, PARKED_VIDEO_SLUGS, mediaMarginTable, animateWorstCaseUsd } = K;
const { examplePngBase64 } = await import("../src/tools/image-size.js");
const { runAsRouteCall } = await import("../src/not-charged.js");
const { toolErrorFields } = await import("../src/tool-error-fields.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
const { settleFirstSlugs } = await import("../src/settle-first-tools.js");
const { isLongRunningSlug, EXPENSIVE_COMPOSITE_SLUGS } = await import("../src/composite-spend-guard.js");
const { asyncProfileOf } = await import("../src/slow-routes.js");
const { stubGuardResolver, oneV4, GUARD_PUBLIC_STAND_IN } = await import("./lib/guard-resolver-stub.js");
const { costsOrStandInFromCatalog } = await import("./lib/stand-in-costs.js");
const COSTS = await costsOrStandInFromCatalog("test-image-animate");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const tool = IMAGES_FAST_TOOLS.find((t) => t.slug === "image-animate");
const call = (input, req) => runAsRouteCall(() => tool.handler(input, req));
const refusal = async (input, req) => { try { await call(input, req); return null; } catch (e) { return e; } };

// ---- pictures, built from pixels (no binary in the source) ----
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = (w, h) => { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 2; return chunk("IHDR", b); };
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A PNG that declares w x h: its image data is a few bytes, whatever it declares.
const pngDeclaring = (w, h, { twoHeaders = false } = {}) => Buffer.concat([SIG, ihdr(w, h), ...(twoHeaders ? [ihdr(300, 300)] : []), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]);
const SQUARE = Buffer.from(examplePngBase64(), "base64");      // 300 x 300
const PORTRAIT = pngDeclaring(720, 1280);
// A JPEG whose only frame header declares w x h.
const jpegDeclaring = (w, h) => { const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]); return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]); };

// ---- the Video API stub; any other URL goes to the real fetch ----
const realFetch = globalThis.fetch;
const MP4 = Buffer.from("\0\0\0 ftypisom-fake-mp4-bytes");
let video = null;
function videoApi({ statuses = ["pending", "completed"], submitStatus = 202, submitError, failError } = {}) {
  const seen = { submits: [], polls: 0, content: 0 };
  let polls = 0;
  video = async (u, init) => {
    if (init.method === "POST") {
      seen.submits.push(JSON.parse(init.body));
      if (submitStatus >= 400) return { ok: false, status: submitStatus, text: async () => JSON.stringify({ error: submitError ?? { message: "bad" } }) };
      return { ok: true, status: submitStatus, text: async () => JSON.stringify({ id: "anim1", polling_url: `${OPENROUTER_VIDEOS_URL}/anim1`, status: "pending" }) };
    }
    if (u.includes("/content")) { seen.content++; return { ok: true, status: 200, headers: { get: (h) => (h === "content-type" ? "video/mp4" : null) }, arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength), text: async () => "" }; }
    seen.polls++;
    const s = statuses[Math.min(polls++, statuses.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "anim1", status: s, ...(s === "completed" ? { usage: { cost: animateWorstCaseUsd() } } : {}), ...(s === "failed" ? { error: failError } : {}) }) };
  };
  return seen;
}

// The picture host: an undici MockAgent answers the public names; every other
// origin goes to the dispatcher the kit handed fetch (the SSRF dispatcher), so
// a redirect hop to a private address meets the real connect-time guard.
const mock = new MockAgent();
mock.disableNetConnect();
// Built-in fetch speaks the v1 handler API (src/fetch-dispatcher.js); the mock is bridged the same way.
const mockV1 = new Dispatcher1Wrapper(mock);
const PUBLIC = new Set(["img.example.test", "cdn.example.test"]);
class Split extends Dispatcher {
  constructor(real) { super(); this.real = real; }
  dispatch(opts, handler) { return (PUBLIC.has(new URL(opts.origin).hostname) ? mockV1 : this.real).dispatch(opts, handler); }
}
const fetchSeen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(OPENROUTER_VIDEOS_URL)) return video(u, init);
  fetchSeen.push({ url: u, guarded: !!init.dispatcher });
  return realFetch(url, init.dispatcher ? { ...init, dispatcher: new Split(init.dispatcher) } : init);
};
const site = mock.get("https://img.example.test");
const cdn = mock.get("https://cdn.example.test");
// Every name the guard resolves answers the public stand-in, except the ones a case steers.
let steer = () => undefined;
const restoreResolver = stubGuardResolver((host, family) => steer(host, family) ?? oneV4(GUARD_PUBLIC_STAND_IN)(host, family));

// A private host with a real answer: reachable only when the guard is gone.
const privateServer = createServer((req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(SQUARE); });
await new Promise((r) => privateServer.listen(0, "127.0.0.1", r));
const PRIVATE_URL = `http://127.0.0.1:${privateServer.address().port}/secret.png`;

try {
  // ---- the listing ----
  ok(tool?.route === `POST ${ANIMATE_PATH}` && ANIMATE_PATH === "/api/image-animate" && tool.price === `$${ANIMATE_PRICE.toFixed(3)}`, `image-animate at POST /api/image-animate, ${tool?.price}`);
  ok(tool.modelBacked === true && /model-backed/.test(tool.description), "marked model-backed on the definition and in its description");
  ok(WALLET_ONLY_SLUGS.has("image-animate"), "wallet-only: no proof-of-work tier");
  ok(!settleFirstSlugs([]).has("image-animate") && !settleFirstSlugs([]).has("v1-videos") && PARKED_VIDEO_SLUGS.has("image-animate"), "never settled first, like the text-to-video route (its job is parked across calls)");
  ok(isLongRunningSlug("image-animate") && EXPENSIVE_COMPOSITE_SLUGS.has("image-animate"), "long-running (EVM exact only) and under the media spend guard");
  const prof = asyncProfileOf(tool);
  ok(prof?.slow === true && prof.maxSeconds === 240 && prof.expectedSeconds === null, "slow route: runs as a job on Prefer: respond-async, no typical run claimed");
  ok(tool.discovery.inputSchema.required.join() === "prompt,image" && tool.discovery.input.image.startsWith("data:image/png;base64,") && tool.mimeType === undefined, "listing: prompt and image required, a real PNG example, JSON answer");
  ok(mediaMarginTable().some((r) => r.tier === "image-animate" && r.model === ANIMATE_COST_KEY), "the margin table holds the route's own cost row");
  COSTS.rate("the image-to-video bound within the margin share of its price", () => { const r = mediaMarginTable().find((x) => x.tier === "image-animate"); ok(r.worst > 0 && K.withinMargin(r.price, r.worst), "margin: the image-to-video bound is within the margin share of its price"); });
  {
    const U = await import("../src/upstream-costs.js");
    const src = (await import("node:fs")).readFileSync(new URL("../src/upstream-costs.js", import.meta.url), "utf8");
    ok(src.includes(`["media", "${ANIMATE_COST_KEY}"]`) && typeof U.upstreamCostsGaps === "function", "its cost row is a REQUIRED key, so a table without it reads partial");
  }

  // ---- base64 input, the request the provider gets ----
  {
    const seen = videoApi();
    const out = await call({ prompt: "  the square rises  ", image: SQUARE.toString("base64") });
    const b = seen.submits[0];
    ok(seen.submits.length === 1 && b.model === VIDEOS_MODEL && b.duration === 4 && b.resolution === "720p" && b.generate_audio === false && b.prompt === "the square rises", "submit: the locked clip on the video model, the prompt trimmed");
    ok(Array.isArray(b.frame_images) && b.frame_images.length === 1 && b.frame_images[0].frame_type === "first_frame" && b.frame_images[0].image_url.url === `data:image/png;base64,${SQUARE.toString("base64")}` && b.input_references === undefined, "the picture rides as the first frame, a data URL of the bytes read");
    ok(b.aspect_ratio === "16:9" && out.data[0].aspect_ratio === "16:9", "a square picture gets 16:9");
    ok(out.model === VIDEOS_MODEL && out.data[0].b64_json === MP4.toString("base64") && out.data[0].media_type === "video/mp4" && out.data[0].duration_seconds === 4 && out.data[0].resolution === "720p", "answer: the text-to-video route's shape, the clip inline");
    ok(!JSON.stringify(out).includes("anim1") && out.usage.cost === undefined, "no job id and no upstream cost in the answer");
  }
  {
    const seen = videoApi();
    await call({ prompt: "pan up", image: `data:image/png;base64,${PORTRAIT.toString("base64")}` });
    ok(seen.submits[0].aspect_ratio === "9:16", "a data: URL works, and a taller picture gets 9:16");
    const again = videoApi();
    await call({ prompt: "pan up", image: `data:image/png;base64,${PORTRAIT.toString("base64")}`, aspect_ratio: "16:9" });
    ok(again.submits[0].aspect_ratio === "16:9", "an aspect_ratio the caller sets wins");
  }

  // ---- https URL input through the guard ----
  {
    site.intercept({ path: "/photo.png" }).reply(200, SQUARE, { headers: { "content-type": "image/png" } });
    const seen = videoApi();
    fetchSeen.length = 0;
    const got = await call({ prompt: "the square rises", image: "https://img.example.test/photo.png" }).catch((e) => e);
    ok(!(got instanceof Error), `an https URL answers a clip (${got instanceof Error ? got.message.slice(0, 80) : "ok"})`);
    ok(seen.submits.length === 1 && seen.submits[0].frame_images[0].image_url.url === `data:image/png;base64,${SQUARE.toString("base64")}`, "an https URL is read and sent on as a data URL (the provider never gets the caller's URL)");
    ok(fetchSeen.length === 1 && fetchSeen[0].guarded, "the read goes through the SSRF dispatcher");
  }
  {
    site.intercept({ path: "/moved.png" }).reply(302, "", { headers: { location: "https://cdn.example.test/real.png" } });
    cdn.intercept({ path: "/real.png" }).reply(200, SQUARE, { headers: { "content-type": "image/png" } });
    const seen = videoApi();
    await call({ prompt: "the square rises", image: "https://img.example.test/moved.png" }).catch(() => null);
    ok(seen.submits.length === 1, "control: a redirect to another public host is followed");
  }
  const noSubmit = async (input, status, frag, label) => {
    const seen = videoApi();
    const e = await refusal(input);
    ok(e && e.statusCode === status && String(e.message).includes(frag) && seen.submits.length === 0, `${label} -> ${status}, nothing submitted (${e ? `${e.statusCode} ${String(e.message).slice(0, 90)}` : "no throw"})`);
    return e;
  };
  await noSubmit({ prompt: "x", image: PRIVATE_URL.replace("http:", "https:") }, 400, "private address", "an https URL on a private address");
  await noSubmit({ prompt: "x", image: PRIVATE_URL }, 400, "must be https", "an http URL");
  steer = (host, family) => (host === "rebind.example.test" ? (family === 4 ? ["127.0.0.1"] : []) : undefined);
  await noSubmit({ prompt: "x", image: "https://rebind.example.test/a.png" }, 400, "private address", "a name that resolves private");
  steer = () => undefined;
  site.intercept({ path: "/to-private.png" }).reply(302, "", { headers: { location: PRIVATE_URL } });
  await noSubmit({ prompt: "x", image: "https://img.example.test/to-private.png" }, 400, "private address", "a redirect to a private address (refused at the hop's connect)");
  // A compressed body is counted after it is decoded.
  site.intercept({ path: "/bomb.png" }).reply(200, gzipSync(Buffer.concat([SQUARE, Buffer.alloc(ANIMATE_MAX_IMAGE_BYTES + 1024)])), { headers: { "content-type": "image/png", "content-encoding": "gzip" } });
  await noSubmit({ prompt: "x", image: "https://img.example.test/bomb.png" }, 413, "over 6 MB", "a gzip body that decodes past the cap");
  site.intercept({ path: "/page" }).reply(200, "<html>not a picture</html>", { headers: { "content-type": "text/html" } });
  await noSubmit({ prompt: "x", image: "https://img.example.test/page" }, 400, "not a PNG or JPEG", "a URL that answers HTML");

  // ---- refusals from the bytes, before anything decodes them ----
  await noSubmit({ prompt: "x", image: pngDeclaring(20_000, 20_000).toString("base64") }, 413, "declares 20000x20000", "a PNG header declaring 400 megapixels (pixel bomb)");
  await noSubmit({ prompt: "x", image: pngDeclaring(8_000, 6_000).toString("base64") }, 413, "megapixels", `a PNG past ${ANIMATE_MAX_PIXELS / 1e6} MP inside the side cap`);
  await noSubmit({ prompt: "x", image: jpegDeclaring(9_000, 300).toString("base64") }, 413, "declares 9000x300", "a JPEG frame header past the side cap");
  await noSubmit({ prompt: "x", image: pngDeclaring(300, 300, { twoHeaders: true }).toString("base64") }, 400, "IHDR", "a PNG with a second IHDR (the size a decoder reads is not the first)");
  await noSubmit({ prompt: "x", image: pngDeclaring(100, 300).toString("base64") }, 400, "at least 256", "a picture under the minimum side");
  await noSubmit({ prompt: "x", image: Buffer.from("GIF89a" + "x".repeat(40)).toString("base64") }, 400, "not a PNG or JPEG", "a GIF");
  await noSubmit({ prompt: "x", image: "A".repeat(Math.ceil(ANIMATE_MAX_IMAGE_BYTES / 3) * 4 + 8) }, 413, "over 6 MB", "base64 past the cap (refused before it is decoded)");
  await noSubmit({ prompt: "x", image: "not base64!!" }, 400, "not valid base64", "a string that is not base64");
  await noSubmit({ image: SQUARE.toString("base64") }, 400, '"prompt" is required', "no prompt");
  await noSubmit({ prompt: "x" }, 400, '"image" is required', "no picture");
  await noSubmit({ prompt: "x", image: SQUARE.toString("base64"), duration: 8 }, 400, "locked to 4", "another duration");
  await noSubmit({ prompt: "x", image: SQUARE.toString("base64"), generate_audio: true }, 400, "silent", "audio");
  await noSubmit({ prompt: "x", image: SQUARE.toString("base64"), aspect_ratio: "1:1" }, 400, "aspect_ratio", "an unsupported aspect");
  await noSubmit({ prompt: "x", image: SQUARE.toString("base64"), last_frame: "x" }, 400, "first frame", "a last frame");
  {
    delete process.env.OPENROUTER_API_KEY;
    site.intercept({ path: "/unread.png" }).reply(200, SQUARE).times(1);
    fetchSeen.length = 0;
    await noSubmit({ prompt: "x", image: "https://img.example.test/unread.png" }, 503, "not configured", "no key");
    ok(fetchSeen.length === 0, "…and the caller's URL is not read");
    process.env.OPENROUTER_API_KEY = "test-key";
  }

  // ---- content filter and outage ----
  {
    videoApi({ submitStatus: 400, submitError: { message: "The input image violates our safety policy", code: "content_policy_violation" } });
    const e = await refusal({ prompt: "x", image: SQUARE.toString("base64") });
    ok(e?.statusCode === 422 && e.contentFiltered === true && toolErrorFields(e).reason === "content_filtered" && /Nothing was charged/.test(e.message), `a submit the provider's filter refuses -> 422 content_filtered (${e?.statusCode})`);
    ok(/Nothing was charged\. Change the prompt or the picture and try again\.$/.test(String(e?.message)), `…image-animate names the prompt and the picture it takes (${e?.message})`);
  }
  {
    videoApi({ statuses: ["failed"], failError: "Video generation completed with no output (content may have been filtered)" });
    const e = await refusal({ prompt: "x", image: SQUARE.toString("base64") });
    ok(e?.statusCode === 422 && toolErrorFields(e).reason === "content_filtered", "a job the filter stopped -> 422 content_filtered");
  }
  {
    videoApi({ submitStatus: 400, submitError: { message: "duration must be one of 4, 6, 8" } });
    const e = await refusal({ prompt: "x", image: SQUARE.toString("base64") });
    ok(e?.statusCode === 502 && !e.contentFiltered, "control: a provider 4xx that names no filter stays 502");
  }
  for (const [label, opts] of [["submit 500", { submitStatus: 500 }], ["submit 429", { submitStatus: 429 }], ["job failed", { statuses: ["failed"], failError: { message: "Internal error while rendering" } }], ["filter service down", { statuses: ["failed"], failError: "Content moderation service is temporarily unavailable" }]]) {
    videoApi(opts);
    const e = await refusal({ prompt: "x", image: SQUARE.toString("base64") });
    ok(e?.statusCode >= 500 && !e.contentFiltered, `an outage (${label}) stays 5xx (${e?.statusCode})`);
  }

  // ---- a timed-out call is collected by the same request again ----
  {
    const payReq = (from) => { const h = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from } } })).toString("base64"); return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined), ip: "203.0.113.9" }; };
    const buyer = `0x${"c".repeat(40)}`;
    site.intercept({ path: "/photo2.png" }).reply(200, SQUARE).times(2);
    const t = videoApi({ statuses: ["pending"] });
    const late = await refusal({ prompt: "the square rises", image: "https://img.example.test/photo2.png" }, payReq(buyer));
    ok(late?.statusCode === 504 && /collect this clip/.test(late.message) && t.submits.length === 1, "a timed-out generation -> 504 that offers collection (not charged)");
    const r = videoApi();
    const out = await call({ prompt: "the square rises", image: "https://img.example.test/photo2.png" }, payReq(buyer));
    ok(r.submits.length === 0 && r.polls > 0 && out.data[0].b64_json === MP4.toString("base64"), "the same request again from the same wallet collects the parked clip with no new submit");
    const other = videoApi();
    await call({ prompt: "the square rises", image: SQUARE.toString("base64") }, payReq(`0x${"d".repeat(40)}`));
    ok(other.submits.length === 1, "another wallet never collects it");
  }
} finally {
  restoreResolver();
  globalThis.fetch = realFetch;
  await new Promise((r) => privateServer.close(r));
  await mock.close();
}

console.log(`\ntest-image-animate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
