// Stand-in upstream costs: what a suite runs on when the private cost table
// (src/upstream-costs.js) is not loaded, so a developer's machine and a fork
// PR still exercise every check that needs A cost, not the real one.
//
// Where the numbers come from, and nowhere else:
//   - the committed placeholder table, docs/example-upstream-costs.json. Its
//     own first line says what it is: every number a placeholder, not a real
//     or suggested rate. scripts/test-upstream-costs.js keeps it in step with
//     the loader's required keys, and scripts/test-example-costs-suites.js
//     keeps the gateway suites passing on it.
//   - for a row that file lacks, a FIXED SHARE of the tool's own public list
//     price (STAND_IN_SHARE of the margin share of the price, stepped per row
//     so two rows never hold the same figure). A suite names the rows and
//     their list prices; the share is defined here, once.
// No real rate is typed, derived or printed here, and a stand-in never
// reaches a server that sells: it is installed only by a test.
//
// A check whose MEANING is the real rate (a margin floor, a drift bound, a
// row the real table must hold) proves nothing on a stand-in. A suite wraps
// it in `costs.rate(label, fn)`: with the table it runs; without it, it is
// counted and named as "needs the table", never run. When the suite ends, one
// line reports the count: under CI the missing table is a failure (exit 1,
// after everything that could run did), locally the rate checks alone are
// skipped. A fork PR's run (UPSTREAM_COSTS_OPTIONAL=1) is treated as local.
import { readFileSync } from "node:fs";
import { setUpstreamCostsForTest } from "../../src/upstream-costs.js";
import { upstreamCostsMissing, upstreamCostsRequired } from "./require-upstream-costs.js";

/** The share of (margin x list price) a derived stand-in row starts at. */
export const STAND_IN_SHARE = 0.5;
/** Each further derived row adds this, so no two rows read the same. */
export const STAND_IN_STEP = 0.04;
/** The gateway's worst-case bound as a share of a tier price (src/tools/llm-gateway-kit.js MARGIN), restated so this helper imports no kit. */
const MARGIN_SHARE = 0.7;

const EXAMPLE = new URL("../../docs/example-upstream-costs.json", import.meta.url);

/** One derived figure: the i-th row sold at `listPriceUsd`. */
export function standInUsd(listPriceUsd, i = 0) {
  return +(listPriceUsd * MARGIN_SHARE * (STAND_IN_SHARE + STAND_IN_STEP * i)).toFixed(6);
}

/**
 * The stand-in table: the placeholder file, plus derived rows.
 * @param {object} [o]
 * @param {Array<[string, number]>} [o.media]  [model, the cheapest public list price it is sold at]:
 *        each gets worstCaseUsd = listedMaxUsd = standInUsd(price, its index)
 */
export function standInCosts({ media = [], speech = [], sttPerMinute = [] } = {}) {
  const table = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  delete table._readme;
  table.media = { ...(table.media || {}) };
  media.forEach(([model, price], i) => { const usd = standInUsd(price, i); table.media[model] = { worstCaseUsd: usd, listedMaxUsd: usd }; });
  // Per-unit rows: the same share of the list price of the LARGEST call the
  // tier serves, spread over that call's units (characters, minutes).
  table.speech = { ...(table.speech || {}) };
  speech.forEach(([model, price, units], i) => { table.speech[model] = standInUsd(price, i) / units; });
  table.sttPerMinute = { ...(table.sttPerMinute || {}) };
  sttPerMinute.forEach(([model, price, units], i) => { table.sttPerMinute[model] = standInUsd(price, i) / units; });
  return table;
}

/** Keep, per model, the row whose list price per unit is lowest (the tier it is sold cheapest at). */
function cheapest(rows) {
  const by = new Map();
  for (const [model, price, units = 1] of rows) { const cur = by.get(model); if (!cur || price / units < cur[1] / cur[2]) by.set(model, [model, price, units]); }
  return [...by.values()];
}

/**
 * The rows the media, speech and transcription kits read, named from the
 * kits' own public tiers: every image link and the video model at the
 * cheapest tier price it is sold at, every speech model at its tier's quote
 * for the longest text, every transcription model at its tier's price for the
 * longest audio. Imports the kits, so it is called only without the table.
 */
export async function catalogStandInRows() {
  const img = await import("../../src/tools/llm-images-fast-kit.js");
  const tts = await import("../../src/tools/tts-kit.js");
  const stt = await import("../../src/tools/stt-kit.js");
  const media = [];
  for (const t of Object.values(img.IMAGE_TIERS)) for (const l of t.chain) media.push([l.model, t.price]);
  media.push([img.VIDEOS_MODEL, img.VIDEOS_PRICE]);
  media.push([img.ANIMATE_COST_KEY, img.ANIMATE_PRICE]);
  const speech = [];
  for (const [slug, t] of Object.entries(tts.TTS_TIERS)) {
    // A quoted tier's price for its longest text; a flat tier's listed price.
    const listed = Number(String(tts.TTS_TOOLS.find((x) => x.slug === slug)?.price ?? "").replace(/^\$/, ""));
    const price = tts.TTS_QUOTE[slug] ? tts.ttsQuoteUsd(slug, t.maxChars) : listed;
    // The backup models stand behind every chained tier.
    const models = new Set([t.model, ...(t.chain || []), ...(t.chain ? tts.TTS_BACKUP_MODELS : [])]);
    for (const model of models) if (model && Number.isFinite(price) && price > 0 && t.maxChars > 0) speech.push([model, price, t.maxChars]);
  }
  const minutes = [];
  for (const [slug, t] of Object.entries(stt.STT_TIERS)) {
    const extra = (stt.sttAdditions?.(slug) || []).map((m) => m?.id || m?.model || m).filter((m) => typeof m === "string");
    for (const model of new Set([t.model, t.diarizeModel, ...extra])) if (model) minutes.push([model, t.priceUsd, t.maxMinutes]);
  }
  return { media: cheapest(media).map(([m, p]) => [m, p]), speech: cheapest(speech), sttPerMinute: cheapest(minutes) };
}

/** costsOrStandIn with the kits' own rows derived (see catalogStandInRows). */
export async function costsOrStandInFromCatalog(suite) {
  return costsOrStandIn(suite, upstreamCostsMissing() ? await catalogStandInRows() : {});
}

/**
 * Call where a suite used to require the private table.
 * With the table: nothing changes ({ real: true }). Without it: the stand-in
 * is installed for this process and handed to every child the suite starts
 * (UPSTREAM_COSTS_JSON), and the suite's end reports the rate checks.
 * @returns {{ real: boolean, standIn: boolean, why: string|null, rate: (label: string, fn: () => any) => any, needsTable: (label: string) => void }}
 */
export function costsOrStandIn(suite, { media, speech, sttPerMinute } = {}) {
  const why = upstreamCostsMissing();
  const needs = [];
  const costs = {
    real: !why, standIn: Boolean(why), why,
    /** Run a rate check with the table; count it as "needs the table" without. */
    rate(label, fn) { if (!why) return fn(); needs.push(label); return undefined; },
    needsTable(label) { if (why) needs.push(label); },
    get needed() { return needs.length; },
  };
  if (!why) return costs;
  const table = standInCosts({ media, speech, sttPerMinute });
  setUpstreamCostsForTest(table);
  process.env.UPSTREAM_COSTS_JSON = JSON.stringify(table);
  delete process.env.UPSTREAM_COSTS_FILE;
  console.log(`# ${suite}: ${why}; running on stand-in costs (placeholder table and list-price shares, no real rate)`);
  process.on("exit", (code) => {
    const n = needs.length;
    const list = n ? `: ${needs.slice(0, 6).join("; ")}${n > 6 ? `; and ${n - 6} more` : ""}` : "";
    if (upstreamCostsRequired()) {
      console.error(`FAIL - ${suite} (rate checks): ${why} (set UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE); ${n} check(s) need the table${list}`);
      if (!code) process.exitCode = 1;
    } else {
      console.log(`SKIP - ${suite} (rate checks only; the rate-free checks ran): ${n} check(s) need the table${list}`);
    }
  });
  return costs;
}
