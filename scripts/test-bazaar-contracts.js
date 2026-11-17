#!/usr/bin/env node
// CLEANROOM 53: implement per spec 53
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
// CLEANROOM 53: implement per spec 53
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
// CLEANROOM 53: implement per spec 53
import { gradeX402Response } from "../src/tools/x402-kit.js";
import { CAIP2_PATTERN } from "../src/avm-network.js";
import { hasShortenedExample, replayableInput, openapiOperation } from "./lib/replayable-example.js";
import { listingInjectionFinding, addressesReader } from "../src/listing-screen.js";
import { readFileSync } from "node:fs";
import { BAZAAR_DESCRIPTIONS, bazaarCapDescription, isExamplePointer, TAG_FILLER, slugRepeatsTag } from "../src/payments.js";
import { attributionTailOf } from "../src/data-attribution.js";

// Routes whose 402 carried a real sample output on the baseline tree. A route
// over its byte budget may carry the /openapi.json pointer instead (counted
// apart below); one of these giving up its real example to it is a regression.
const REAL_EXAMPLE_BASELINE = new Set(JSON.parse(readFileSync(new URL("./bazaar-example-baseline.json", import.meta.url), "utf8")).routes);
// The typed-judgment listings (descriptionFirst in their kits): each keeps its
// whole description beside the sample-answer pointer, and judge its model enum.
const openapiOutputExample = (openapi, endpoint) => {
  const ok = openapiOperation(openapi, endpoint.method || "GET", endpoint.path)?.responses?.["200"]?.content?.["application/json"];
  return ok?.example ?? ok?.examples?.default?.value;
};
const WHOLE_LISTING_ROUTES = new Set(["POST /v1/judge", "POST /v1/decisions", "POST /v1/judge/vision", "POST /api/loop-gate"]);
// CLEANROOM 53: implement per spec 53
// The JSON body mirrors the header's PaymentRequired object (see
// src/payment-required-body.js). Nobody echoes the body back, so this is not
// the header's echo ceiling; it is a ratchet so a mirrored body cannot grow
// without anyone noticing.
const MAX_BODY_BYTES = 12_000;
// That ceiling is checked on this boot's single rail, where bodies run about
// half the size a many-rail offer produces, so on its own it cannot see a
// production-shaped body. The composition check can: a mirrored body is the
// decoded header plus our own fields and nothing more, so it is bounded by the
// header (which scripts/test-challenge-size.js caps against production) plus
// our own fields, and those are capped here.
const MAX_OWN_FIELD_BYTES = 2_048;
// CLEANROOM 53: implement per spec 53
const child = spawn(process.execPath, ["src/server.js"], { env: serverEnv(port), stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

// CLEANROOM 53: implement per spec 53
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  // CLEANROOM 53: implement per spec 53
  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  // CLEANROOM 53: implement per spec 53
  // The paid sweeps replay each 402's example input; a long string there is
  // a placeholder, and the full example must come back from /openapi.json.
  const openapi = await (await fetch(`${base}/openapi.json`)).json();
  let shortenedExamples = 0;

  // CLEANROOM 53: implement per spec 53
  // The amount a 402 asks for against what the price list publishes. A
  // fixed-price route asks exactly its list price. A quoted route (its row says
  // quoted: true with a quoteRange) prices the body it was sent, so its 402 for
  // this probe's empty body lands anywhere inside the published range, whose
  // floor is the list price. This boot offers Base only, so accepts[0] is USDC
  // on Base at six decimals; compared as integer micro-dollars.
  const microOf = (usd) => Math.round(Number(String(usd ?? "").replace(/[^0-9.]/g, "")) * 1e6);
  let fixedPriced = 0;
  let quotedPriced = 0;
  // CLEANROOM 53: implement per spec 53
  let largestBody = { route: "", bytes: 0 };
  let largestOwn = { route: "", bytes: 0 };
  // CLEANROOM 53: implement per spec 53
  // path -> listing mimeType, for every tool whose example answers raw bytes.
  const binaryListings = new Map();
  const method0 = (route) => route.split(" ")[0];
  // CLEANROOM 53: implement per spec 53
  // Fields the Bazaar ranks on (description, output schema, service metadata):
  // routes that carry each one, printed and required of every route.
  const has = { serviceName: 0, tags: 0, icon: 0, description: 0, input: 0, output: 0, outputSchema: 0, screened: 0 };
  // A pointer stands in for a sample output too large for the 402: legitimate
  // for an oversized route, counted apart so it never reads as a real example.
  has.outputPointer = 0; has.outputSchemaPointer = 0;
  let wholeListingSeen = 0;
  // The transcription routes declare the two fields a cut answer adds
  // (discovery.output.optional); their listing's schema carries both.
  const TRIM_ROUTES = new Set(["/api/transcribe", "/api/transcribe-pro", "/v1/audio/transcriptions", "/v1/pro/audio/transcriptions"]);
  let trimSeen = 0;
  const attributedSeen = new Set();
  const LISTING_ICON = /\.(?:png|jpe?g|webp|gif)$/i;
  const iconPaths = new Set();

  for (const { endpoint, route, status, encoded, bodyText, cacheControl } of rows) {
    // CLEANROOM 53: implement per spec 53

    // The body carries the same object as the header, key for key.
    const bodyBytes = Buffer.byteLength(bodyText || "");
    if (bodyBytes > largestBody.bytes) largestBody = { route, bytes: bodyBytes };
    if (bodyBytes > MAX_BODY_BYTES) fail(route, `${bodyBytes}-byte 402 body exceeds ${MAX_BODY_BYTES}`);
    let body = null;
    try { body = JSON.parse(bodyText); } catch { fail(route, `402 body is not JSON: ${String(bodyText).slice(0, 80)}`); }
    if (body) {
      const differs = Object.keys(paymentRequired).filter((k) => !isDeepStrictEqual(body[k], paymentRequired[k]));
      if (differs.length) fail(route, `402 body does not mirror the header on: ${differs.join(",")}`);
      const own = Object.fromEntries(Object.entries(body).filter(([k]) => !(k in paymentRequired)));
      const ownBytes = Buffer.byteLength(JSON.stringify(own));
      if (ownBytes > largestOwn.bytes) largestOwn = { route, bytes: ownBytes };
      if (ownBytes > MAX_OWN_FIELD_BYTES) fail(route, `402 body's own fields (${Object.keys(own).join(",")}) take ${ownBytes} bytes, over ${MAX_OWN_FIELD_BYTES}`);
      const headerJsonBytes = Buffer.from(encoded, "base64").length;
      if (bodyBytes > headerJsonBytes + ownBytes) fail(route, `402 body is ${bodyBytes} bytes, more than the decoded header (${headerJsonBytes}) plus its own fields (${ownBytes})`);
      const bodyParsed = parsePaymentRequired(body);
      if (!bodyParsed.success) fail(route, `402 body PaymentRequiredSchema: ${bodyParsed.error.issues[0]?.message || "invalid"}`);
      // Our own grader, run on our own mirrored body: no tool description or
      // example may make it read as an internal-error leak.
      const graded = gradeX402Response({ href: `${base}${endpoint.path}`, protocol: "https:", status, cacheControl, bodyText, paymentRequiredHeader: encoded });
      const hygiene = (graded.checks || []).find((c) => c.id === "error-hygiene");
      if (!hygiene || hygiene.status !== "pass") fail(route, `402 body fails error-hygiene: ${hygiene?.detail || "check missing"}`);
    }
    const listing = paymentRequired.resource || {};
    if (typeof listing.serviceName === "string" && listing.serviceName.trim()) has.serviceName++; else fail(route, "listing has no serviceName");
    if (Array.isArray(listing.tags) && listing.tags.length >= 1 && listing.tags.length <= 5 && (!endpoint.category || listing.tags[0] === endpoint.category)) has.tags++;
    else fail(route, `listing tags are not 1..5 led by the category: ${JSON.stringify(listing.tags)}`);
    // The slug outranks the generic fillers: a listing that reaches a filler
    // carries its slug first, unless the slug only repeats a tag it has.
    if (Array.isArray(listing.tags) && endpoint.slug) {
      // The trailing run of fillers (a tool may carry "x402" as its own tag).
      let firstFiller = listing.tags.length;
      while (firstFiller > 0 && TAG_FILLER.includes(listing.tags[firstFiller - 1])) firstFiller--;
      if (firstFiller === listing.tags.length) firstFiller = -1;
      const named = firstFiller < 0 ? listing.tags : listing.tags.slice(0, firstFiller);
      if (firstFiller >= 0 && !named.includes(endpoint.slug) && !slugRepeatsTag(endpoint.slug, named)) fail(route, `listing reaches a filler tag before its slug: ${JSON.stringify(listing.tags)}`);
      if (listing.tags.indexOf(endpoint.slug) > firstFiller && firstFiller >= 0) fail(route, `listing puts a filler before its slug: ${JSON.stringify(listing.tags)}`);
    }
    let iconPath = "";
    try { iconPath = new URL(listing.iconUrl).pathname; } catch { /* checked below */ }
    if (LISTING_ICON.test(iconPath)) { has.icon++; iconPaths.add(iconPath); } else fail(route, `listing icon is not a PNG, JPG, WebP or GIF path: ${listing.iconUrl}`);
    const desc = String(listing.description || "");
    if (desc.length >= 40 && desc.length <= 500 && !/(?:^|\s)\(?\?[a-zA-Z_]\w*=/.test(desc)) has.description++;
    else fail(route, `listing description is ${desc.length} chars or keeps a query hint (40..500, no hint): ${desc.slice(0, 80)}`);
    // The Bazaar delists metadata that reads as an instruction to an agent.
    // Our own two screens read every listing the way they read a seller's.
    {
      const finding = listingInjectionFinding(`${listing.serviceName ?? ""} ${desc} ${(listing.tags || []).join(" ")} ${endpoint.slug ?? ""} ${endpoint.path}`);
      const sentence = desc.split(/(?<=[.!?])\s+/).find((x) => addressesReader(x));
      const ident = [listing.serviceName, ...(listing.tags || [])].find((x) => x && addressesReader(x));
      if (finding || sentence || ident) fail(route, `listing trips the listing screen (${finding || "reader"}): ${sentence || ident || desc.slice(0, 80)}`);
      else has.screened++;
    }
    // The listing's content type is the one the published example answers
    // with, read from the tool def (its mimeType, which the /api/pricing row
    // carries when it is not JSON). A binary tool's listing names its bytes,
    // and its /openapi.json 200 lists the same type first.
    {
      const want = endpoint.mimeType || "application/json";
      if (listing.mimeType !== want) fail(route, `listing mimeType is ${listing.mimeType}, the tool answers its example with ${want}`);
      if (endpoint.mimeType) binaryListings.set(endpoint.path, listing.mimeType);
      const types = Object.keys(openapiOperation(openapi, method0(route), endpoint.path)?.responses?.["200"]?.content || {});
      const wantTypes = endpoint.responseTypes || [want];
      if (!isDeepStrictEqual(types, wantTypes)) fail(route, `/openapi.json 200 content types ${JSON.stringify(types)} are not ${JSON.stringify(wantTypes)}`);
    }
    // CLEANROOM 53: implement per spec 53
    {
      // accepts[0] is read here ahead of the outputSchema checks below, which
      // declare their own `accepts` for the whole list.
      const amount = Number(paymentRequired.accepts?.[0]?.amount);
      const list = microOf(endpoint.price);
      if (!Number.isFinite(amount) || !(list > 0)) fail(route, `unreadable 402 amount (${paymentRequired.accepts?.[0]?.amount}) or list price (${endpoint.price})`);
      else if (endpoint.quoted === true) {
        quotedPriced++;
        const min = microOf(endpoint.quoteRange?.minUsd), max = microOf(endpoint.quoteRange?.maxUsd);
        if (!(min > 0) || !(max >= min)) fail(route, `quoted row without a usable quoteRange (${JSON.stringify(endpoint.quoteRange)})`);
        else if (min !== list) fail(route, `quoted row's floor (${min}) is not its list price (${list})`);
        else if (amount < min || amount > max) fail(route, `402 asks ${amount} micro-USD, outside the published range ${min}..${max}`);
      } else {
        fixedPriced++;
        if (amount !== list) fail(route, `402 asks ${amount} micro-USD, list price is ${list} (a route whose 402 varies must say quoted: true with a quoteRange on /api/pricing)`);
      }
    }

    // CLEANROOM 53: implement per spec 53
    {
      const input = extension.info?.input;
      if (hasShortenedExample(input?.body) || hasShortenedExample(input?.queryParams)) {
        shortenedExamples++;
        const replay = replayableInput(input, openapiOperation(openapi, endpoint.method || "GET", endpoint.path));
        if (!replay) fail(route, "the 402's example input is shortened and /openapi.json has no full example to replay");
        else if (hasShortenedExample(replay)) fail(route, "the replayable example still carries a placeholder");
      }
      if (endpoint.path === "/api/html-frames" && hasShortenedExample(input)) fail(route, "html-frames' 402 example lost its document to the byte budget");
    }
    // CLEANROOM 53: implement per spec 53
    // accepts[0].outputSchema (2026-09-02): the spec's own field carries the
    // extension's typed schema, on the FIRST accept only (one copy, never per
    // rail: the buyer echoes the challenge back).
    const accepts = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : [];
    // The Bazaar validator parses every accept's network with the strict
    // CAIP-2 grammar (reference at most 32 characters of [-_a-zA-Z0-9]); one
    // id outside it drops the whole route from discovery.
    for (const a of accepts) if (!CAIP2_PATTERN.test(String(a?.network || ""))) fail(route, `accept network "${a?.network}" is not a strict CAIP-2 id`);
    if (outputSchema) {
      if (JSON.stringify(accepts[0]?.outputSchema) !== JSON.stringify(outputSchema)) fail(route, "accepts[0].outputSchema is not the extension's typed output schema");
      if (accepts.slice(1).some((a) => a.outputSchema !== undefined)) fail(route, "outputSchema duplicated onto a later accept");
    } else if (accepts[0]?.outputSchema !== undefined) fail(route, "accepts[0].outputSchema present with no extension schema to source it");
    if (extension.info?.input) has.input++; else fail(route, "bazaar extension has no input");
    const pointer = isExamplePointer(example);
    if (example === undefined) fail(route, "bazaar extension has no output example");
    else if (pointer) {
      has.outputPointer++;
      if (REAL_EXAMPLE_BASELINE.has(route)) fail(route, "the 402 carried a real sample output on the baseline and now carries the /openapi.json pointer");
    } else has.output++;
    if (!outputSchema) fail(route, "bazaar extension has no output schema");
    else if (pointer) has.outputSchemaPointer++;
    else has.outputSchema++;
    // A catalog text that ends with the attribution its sources' terms require
    // (src/data-attribution.js; a pack carries one per source its tools serve)
    // keeps the same run at the end of its 402 listing, whatever the budget cut.
    const attribution = attributionTailOf(endpoint.description || "");
    if (attribution) {
      attributedSeen.add(endpoint.slug);
      if (!desc.endsWith(attribution)) fail(route, `listing lost the attribution its catalog text ends with: ...${desc.slice(-80)}`);
    }
    if (WHOLE_LISTING_ROUTES.has(route)) {
      wholeListingSeen++;
      const source = BAZAAR_DESCRIPTIONS[endpoint.slug] || endpoint.description;
      if (!source) fail(route, "no catalog description to compare the listing with");
      else if (desc !== bazaarCapDescription(source)) fail(route, `listing description was cut by the byte budget (${desc.length} of ${bazaarCapDescription(source).length} chars): ${desc.slice(-60)}`);
      if (!(pointer || isDeepStrictEqual(example, openapiOutputExample(openapi, endpoint)))) fail(route, "sample output is neither the real example nor the /openapi.json pointer");
      if (endpoint.path === "/v1/judge") {
        const modelEnum = extension.schema?.properties?.input?.properties?.body?.properties?.model?.enum;
        const published = openapiOperation(openapi, "POST", endpoint.path)?.requestBody?.content?.["application/json"]?.schema?.properties?.model?.enum;
        if (!Array.isArray(published) || !published.length) fail(route, "/openapi.json publishes no model enum to compare the listing with");
        else if (!isDeepStrictEqual(modelEnum, published)) fail(route, `listing input lost the model enum (${JSON.stringify(modelEnum)})`);
      }
    }
    if (binaryListings.has(endpoint.path)) {
      // A binary listing carries a string naming its bytes and a string
      // schema with their media type, never a JSON object for a buyer to
      // take as the answer's shape.
      if (typeof example !== "string" || !example.includes(listing.mimeType)) fail(route, `binary listing's sample output does not name its ${listing.mimeType} bytes: ${JSON.stringify(example)}`);
      if (outputSchema?.type !== "string" || outputSchema?.contentMediaType !== listing.mimeType) fail(route, `binary listing's output schema is not a ${listing.mimeType} string: ${JSON.stringify(outputSchema)}`);
      if (extension.info?.output?.type !== "binary") fail(route, `binary listing's output.type is ${JSON.stringify(extension.info?.output?.type)}, not "binary"`);
    } else if (extension.info?.output && extension.info.output.type !== "json") fail(route, `JSON listing's output.type is ${JSON.stringify(extension.info.output.type)}`);
    // CLEANROOM 53: implement per spec 53
    if (TRIM_ROUTES.has(endpoint.path)) {
      trimSeen++;
      if (outputSchema.properties?.trimmedToCapSeconds?.type !== "number" || outputSchema.properties?.durationUnconfirmed?.type !== "boolean") fail(route, "output schema lacks trimmedToCapSeconds and durationUnconfirmed");
    }
// CLEANROOM 53: implement per spec 53
  // The icon every listing names is served as an image (a host without
  // Chromium redirects to the SVG, which this boot may be).
  for (const iconPath of iconPaths) {
    const icon = await fetch(`${base}${iconPath}`, { redirect: "manual" });
    await icon.arrayBuffer();
    const type = icon.headers.get("content-type") || "";
    if (!(icon.status === 200 && type.startsWith("image/png")) && icon.status !== 302) fail(`GET ${iconPath}`, `listing icon answers ${icon.status} ${type}`);
  }
  console.log(`listing fields on ${rows.length} routes: ${Object.entries(has).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`sample outputs: ${has.output} real, ${has.outputPointer} /openapi.json pointers (schemas: ${has.outputSchema} real, ${has.outputSchemaPointer} for a pointer)`);
  // FRED, CoinGecko, Jupiter, GeoNames, Open-Meteo and NVD routes, and the packs that run them.
  if (attributedSeen.size < 60 || ![...attributedSeen].some((s) => s.startsWith("skill-"))) fail("catalog", `checked the attribution on ${attributedSeen.size} listings, packs included (expected 60 or more)`);
  if (trimSeen !== TRIM_ROUTES.size) fail("catalog", `checked ${trimSeen} of ${TRIM_ROUTES.size} transcription listings for the cut-answer fields`);
  if (wholeListingSeen !== WHOLE_LISTING_ROUTES.size) fail("catalog", `checked ${wholeListingSeen} of ${WHOLE_LISTING_ROUTES.size} typed-judgment listings`);
  if (!quotedPriced) fail("catalog", "no quoted route was checked against its published range (the metered tiers and decide are quoted)");
  // CLEANROOM 53: implement per spec 53
  // Derived from the catalog, so these name the floor, not the list: QR,
  // screenshot, the three image transforms and speech answer raw bytes.
  if (binaryListings.size < 6) fail("catalog", `only ${binaryListings.size} binary listings (${[...binaryListings.keys()].join(", ")}); expected 6 or more`);
  if (binaryListings.get("/api/qr") !== "image/png") fail("GET /api/qr", `listed as ${binaryListings.get("/api/qr") || "JSON"}, answers image/png`);
  if (binaryListings.get("/api/image-convert") !== "image/jpeg") fail("POST /api/image-convert", `listed as ${binaryListings.get("/api/image-convert") || "JSON"}, its example answers image/jpeg`);
  if (binaryListings.has("/api/hash")) fail("GET /api/hash", "a JSON tool is listed as binary");
  console.log(`binary listings: ${[...binaryListings].map(([p, t]) => `${p} ${t}`).join(", ")}`);
  // CLEANROOM 53: implement per spec 53
  console.log(`402 amount vs price list: ${fixedPriced} fixed routes at list price, ${quotedPriced} quoted routes inside their published range`);
  // The rollout switch: with X402_BINARY_LISTINGS=off every binary route
  // lists what it listed before it named its bytes: application/json, output
  // type "json" and the sample below (each tool's legacyListingExample), with
  // the schema derived from that sample. A new binary tool adds its row here.
  {
    const LEGACY_SAMPLES = {
      "/api/screenshot": { contentType: "image/png", body: "(binary PNG image)" },
      "/api/qr": { contentType: "image/png", body: "(binary PNG image)" },
      "/api/image-resize": { __note: "returns the resized image as binary (Content-Type set accordingly)" },
      "/api/image-convert": { __note: "returns the converted image as binary" },
      "/api/image-thumbnail": { __note: "returns the square thumbnail as binary" },
      "/v1/audio/speech": "(raw mp3 bytes - Content-Type: audio/mpeg)",
    };
    // CLEANROOM 53: implement per spec 53
    const [offPort] = await getFreePorts(1);
    const off = spawn(process.execPath, ["src/server.js"], { env: serverEnv(offPort, { X402_BINARY_LISTINGS: "off" }), stdio: "ignore" });
    try {
      let offUp = false;
      for (let i = 0; i < 240 && !offUp; i++) {
        try { offUp = (await fetch(`http://127.0.0.1:${offPort}/health`)).ok; } catch { /* booting */ }
        if (!offUp) await wait(250);
      }
      if (!offUp) fail("X402_BINARY_LISTINGS=off", "server did not boot");
      else for (const endpoint of endpoints.filter((e) => e.mimeType || e.path === "/api/hash")) {
        const offRoute = `${String(endpoint.method || "GET").toUpperCase()} ${endpoint.path}`;
        const res = await fetch(`http://127.0.0.1:${offPort}${endpoint.path}`, { method: endpoint.method || "GET", headers: { "content-type": "application/json" }, body: /^(POST|PUT|PATCH)$/i.test(endpoint.method || "") ? "{}" : undefined });
        await res.text();
        const pr = JSON.parse(Buffer.from(res.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
        const ext = pr.extensions?.bazaar;
        if (res.status !== 402 || pr.resource?.mimeType !== "application/json") fail(offRoute, `switch off: ${res.status}, listed as ${pr.resource?.mimeType}`);
        if (ext?.info?.output?.type !== "json" || ext?.info?.output?.example === undefined) fail(offRoute, `switch off: output is ${JSON.stringify(ext?.info?.output)}`);
        if (!ext || !validateDiscoveryExtension(ext).valid || !validateDiscoveryExtensionSpec(ext).valid) fail(offRoute, "switch off: the declaration does not validate");
        if (!endpoint.mimeType) continue;
        const legacy = LEGACY_SAMPLES[endpoint.path];
        const offSchema = ext?.schema?.properties?.output?.properties?.example;
        if (legacy === undefined) fail(offRoute, "a binary listing has no earlier sample recorded for the switch-off listing (LEGACY_SAMPLES)");
        else if (!isDeepStrictEqual(ext?.info?.output?.example, legacy)) fail(offRoute, `switch off: sample is ${JSON.stringify(ext?.info?.output?.example)}, the earlier listing carried ${JSON.stringify(legacy)}`);
        else if (offSchema?.type !== jsonType(legacy) || offSchema?.contentMediaType !== undefined) fail(offRoute, `switch off: output schema is ${JSON.stringify(offSchema)}`);
        else if (!isDeepStrictEqual(pr.accepts?.[0]?.outputSchema, offSchema)) fail(offRoute, "switch off: accepts[0].outputSchema is not the extension's schema");
      }
    } finally { try { off.kill("SIGKILL"); } catch { /* stopped */ } }
  }
  // CLEANROOM 53: implement per spec 53
  console.log(`largest 402 body: ${largestBody.route} at ${largestBody.bytes} bytes; largest own fields: ${largestOwn.route} at ${largestOwn.bytes} bytes`);
  // CLEANROOM 53: implement per spec 53
