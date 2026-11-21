#!/usr/bin/env node
// The wholesale surface (src/wholesale.js, GET /api/wholesale/v1[/<family>],
// /wholesale) and the stable error codes (src/stable-error-code.js):
//   - the v1 field set and the error code table are pinned (a v1 field or
//     code may be added, never removed or renamed);
//   - reliability agrees with /api/reliability/tools (seven days, 20 calls,
//     the same status words and rounding) and publishes no call volume in
//     any form (no count, no band): a rate needs the minimum sample,
//     reads only outside lanes inside 24 hours, rounds down, lies in [0, 1];
//     latency rounds up; volume is a band, never a count;
//   - whether a failed call was charged depends on the rail (a Tempo push
//     transfer is final before the call): no error code's meaning says it,
//     the contract says it once, rail by rail, with the refund terms, and so
//     does the page;
//   - the compute family is our own computation only: a proof-of-work tool
//     that serves a committed outside dataset (country-info, ODbL) or a
//     source's data (an attribution) is not in it;
//   - the contract claims errorCode exactly where it is served: every error
//     answer a tool's route writes other than a 402 (the input check, a run's
//     error, a retired route's 410, a switched-off tool's 503); the 402
//     follows the x402 and MPP wire formats and carries none, and the table
//     lists no code for it;
//   - every tool row carries its own credit line, read from the catalog's
//     attribution, and a family credit line is one every tool in it keeps;
//   - on a FREE_MODE boot: every listed price is /api/pricing's own, no
//     listed tool is model-backed or market data, a family's rates move with
//     real calls, every catalog route's JSON error carries its errorCode, and
//     so does every retired route and every switched-off tool, the page
//     renders; on a paid boot (stub facilitator) the 402 carries none.
//   node scripts/test-wholesale.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { ERROR_CODES, stableErrorCode, errorCodeField } from "../src/stable-error-code.js";
import * as ERROR_CONTRACT from "../src/stable-error-code.js";
import { RETIRED_TOOLS, RETIRED_PACKS } from "../src/retired-tools.js";
import { KALSHI_SLUGS } from "../src/kalshi-switch.js";
import { STOCK_SLUGS } from "../src/tools/stock-provider.js";
import { STOCK_CORE_PACK_SLUGS } from "../src/skills.js";
import { COMMITTED_DATASET_SLUGS } from "../src/wholesale.js";
import { reliabilityOf, toolRow, wholesaleIndex, wholesaleFamily, WHOLESALE_FAMILIES, WHOLESALE_MIN_SAMPLE, WHOLESALE_WINDOW_HOURS, STATUS_MEASURED, STATUS_THIN } from "../src/wholesale.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { toolReliabilityEnabled, TOOL_RELIABILITY_PATH } from "../src/tool-reliability.js";
import { reliabilityDefinition, RELIABILITY_DEFINITION } from "../src/wholesale.js";
import { wholesalePage } from "../src/wholesale-page.js";
import { reliabilityReport } from "../src/discovery.js";
import { preValidateInput } from "../src/handler-input.js";
import { stripScripts } from "./lib/html-text.js";
import { failedCallFootnote, TEMPO_PUSH_EXCEPTION } from "../src/settlement-footnote.js";
import { REFUND_TERMS_PATH } from "../src/refund-terms-path.js";
import { ATTRIBUTION_TAILS, ATTRIBUTIONS, attributionTailOf, OPEN_METEO_ATTRIBUTION, C3S_CREDIT } from "../src/data-attribution.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// ---- error codes: the v1 table only grows. It lists a code only for a
// status whose answers carry one: a 402 is the payment-required answer, which
// follows the x402 and MPP wire formats and carries no errorCode.
const V1_CODES = { 400: "invalid_input", 404: "not_found", 409: "conflict", 410: "retired", 413: "input_too_large", 415: "unsupported_media_type", 422: "input_not_resolvable", 429: "rate_limited", 499: "client_closed", 500: "internal_error", 502: "upstream_error", 503: "unavailable", 504: "timeout" };
for (const [s, c] of Object.entries(V1_CODES)) ok(stableErrorCode(Number(s)) === c && ERROR_CODES.some((e) => e.status === Number(s) && e.code === c), `status ${s} reads ${c}`);
// Within v1 a code is never removed: every (status, code) pair the contract
// has published stays in the table. The 402's row stays, marked carried:
// false (a field added to every row), and no 402 answer carries it.
const V1_PUBLISHED = { ...V1_CODES, 402: "payment_required" };
for (const [s, c] of Object.entries(V1_PUBLISHED)) ok(ERROR_CODES.some((e) => e.status === Number(s) && e.code === c), `the v1 table still lists ${s} ${c}`);
ok(stableErrorCode(402) === null && JSON.stringify(errorCodeField(402)) === "{}" && ERROR_CODES.find((e) => e.status === 402)?.carried === false, `a 402 reads no code, and its row says it is not carried (${JSON.stringify(ERROR_CODES.find((e) => e.status === 402) || "no 402 row")})`);
ok(ERROR_CODES.filter((e) => e.status !== 402).every((e) => e.carried === true), "every other row says its code is carried");
// What the contract says about where errorCode rides: one wording, read by
// the JSON, the page and the changelog alike, that claims no answer it is
// not on (src/stable-error-code.js).
const SCOPE = ERROR_CONTRACT.ERROR_CODE_SCOPE, NOT_CARRIED = ERROR_CONTRACT.ERROR_CODE_NOT_CARRIED;
ok(typeof SCOPE === "string" && /\berrorCode\b/.test(SCOPE) && /other than a 402/.test(SCOPE) && /retired route/.test(SCOPE) && /switched off/.test(SCOPE) && !/every tool error answer/i.test(SCOPE),
  `the scope names the answers that carry errorCode and leaves the 402 out (${JSON.stringify(SCOPE)})`);
ok(typeof NOT_CARRIED === "string" && /\b402\b/.test(NOT_CARRIED) && /x402 and MPP wire formats/.test(NOT_CARRIED) && /carries no errorCode/.test(NOT_CARRIED),
  `the contract says the 402 follows the x402 and MPP wire formats and carries no errorCode (${JSON.stringify(NOT_CARRIED)})`);
// The idempotency layer's 409 is a request check in front of the route and
// carries no code, so the 409 row does not cite it.
ok(!/idempotency/i.test(ERROR_CODES.find((e) => e.status === 409)?.meaning || ""), "the 409 row cites no answer that carries no errorCode (the idempotency layer's 409)");
ok(new Set(ERROR_CODES.map((e) => e.code)).size === ERROR_CODES.length && ERROR_CODES.every((e) => /^[a-z_]+$/.test(e.code) && e.meaning && /^[a-z-]+$/.test(e.retry)), "codes are unique snake_case words, each with a meaning and a retry verb");
ok(ERROR_CODES.every((e) => !/\bcharg(?:e|ed|es|ing)\b/i.test(e.meaning)), `no code's meaning says whether the call was charged, which depends on the rail (${ERROR_CODES.filter((e) => /\bcharg/i.test(e.meaning)).map((e) => e.status).join(", ") || "none"})`);
ok(stableErrorCode(418) === "invalid_input" && stableErrorCode(507) === "internal_error" && stableErrorCode(200) === null && stableErrorCode("x") === null, "an unlisted status reads its class; under 400 reads none");
ok(JSON.stringify(errorCodeField(200)) === "{}" && errorCodeField(504).errorCode === "timeout", "the field spreads to nothing under 400");
{
  // The pre-payment input check (direct routes and /ref) answers in the dispatcher's shape, code included.
  const def = { slug: "zz", route: "POST /api/zz", discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "a" } } };
  const bad = preValidateInput(def, { method: "POST", path: "/api/zz", body: {}, query: {}, headers: { "content-type": "application/json" } });
  ok(bad?.status === 400 && bad.body.errorCode === "invalid_input" && Object.keys(bad.body).slice(0, 3).join(",") === "error,tool,errorCode", `the pre-payment refusal carries errorCode right after tool (${bad && Object.keys(bad.body).join(",")})`);
}

// ---- reliability, pure
const now = Date.parse("2026-11-18T12:00:00Z");
ok(WHOLESALE_WINDOW_HOURS === 168 && WHOLESALE_MIN_SAMPLE === 20, "seven days and a 20-call minimum, as /api/reliability/tools");
{
  // When the per-tool reliability table is in this build, its constants are ours.
  const shared = await import("../src/tool-reliability.js").catch(() => null);
  if (shared) ok(shared.TOOL_RELIABILITY_WINDOW_HOURS === WHOLESALE_WINDOW_HOURS && shared.TOOL_RELIABILITY_MIN_SAMPLE === WHOLESALE_MIN_SAMPLE && shared.STATUS_MEASURED === STATUS_MEASURED && shared.STATUS_THIN === STATUS_THIN, "the same window, minimum and status words as src/tool-reliability.js");
  if (shared) {
    const o = { slug: "x", n: 40, ok: 37, serverErrored: 3, p50: 120, p95: 900 };
    const theirs = shared.reliabilityRow({ slug: "x", route: "GET /api/x" }, o, true);
    const ours = reliabilityOf(o, true);
    ok(["status", "measured", "successRate", "p50Ms", "p95Ms"].every((k) => theirs[k] === ours[k]), "the same row figures as /api/reliability/tools for the same outcome");
  }
}
const r = reliabilityOf({ n: 38, ok: 35, p50: 101, p95: 999 }, true);
ok(r.status === STATUS_MEASURED && r.measured === true && r.successRate === Math.floor((35 / 38) * 1000) / 1000 && r.p50Ms === 101 && r.p95Ms === 999, `measured: rate floored to three places, latency as read (${JSON.stringify(r)})`);
const thin = reliabilityOf({ n: WHOLESALE_MIN_SAMPLE - 1, ok: WHOLESALE_MIN_SAMPLE - 1, p50: 5, p95: 9 }, true);
ok(thin.status === STATUS_THIN && thin.measured === false && thin.successRate === null && thin.p50Ms === null && thin.p95Ms === null, "under the minimum: not enough data, every figure null");
ok(reliabilityOf({ n: 500, ok: 500 }, false).status === STATUS_THIN && reliabilityOf(undefined, true).status === STATUS_THIN, "unreadable outcomes or no row: not enough data, never a figure");
ok(reliabilityOf({ n: 25, ok: 0, p50: 1, p95: 2 }, true).successRate === 0, "every call failing reads 0, not null");
ok(reliabilityOf({ n: 1000, ok: 999 }, true).successRate === 0.999 && reliabilityOf({ n: 10000, ok: 9999 }, true).successRate < 1, "any failure keeps the rate under 1");
// No call volume in any form.
const VOLUME_KEY = /^(n|calls?|count|counts|volume|sample|samples|sampleSize|band|callsBand|serverErrors|requests|total)$/i;
const BAND_VALUE = /^(<\d+|\d+-\d+|\d+\+)$/;
const noVolume = (o, path = "") => {
  const bad = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (VOLUME_KEY.test(k)) bad.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
    else if (typeof v === "string" && BAND_VALUE.test(v)) bad.push(`${p}=${v}`);
  };
  walk(o, path);
  return bad;
};
ok(noVolume(reliabilityOf({ n: 12345, ok: 12000, p50: 1, p95: 2 }, true)).length === 0 && !JSON.stringify(reliabilityOf({ n: 12345, ok: 12000, p50: 1, p95: 2 }, true)).includes("12345"), "a reliability block carries no count and no band, and never the count it read");

// ---- field contract (v1 only grows)
const ROW_KEYS = ["slug", "name", "method", "path", "url", "price", "modelBacked", "docs", "reliability", "credit"];
// The credit a tool's catalog entry says its source requires: its attribution
// key's sentence, else the attribution run its description ends with.
const catalogCredit = (def) => ATTRIBUTIONS[def?.attribution] || attributionTailOf(String(def?.description || "")) || null;
// A row keeps that credit whole (a family-level line in its place does not).
const creditCovers = (row, def) => { const need = catalogCredit(def); return !need || (typeof row?.credit === "string" && row.credit.includes(need)); };
{
  const c3sTool = { slug: "weather-history", name: "H", price: "$0.002", attribution: "open-meteo-c3s", description: `History. ${ATTRIBUTIONS["open-meteo-c3s"]}` };
  const r3 = toolRow("GET /api/weather-history", c3sTool, { baseUrl: "https://x.test", outcome: undefined, available: true, familyCredit: OPEN_METEO_ATTRIBUTION });
  ok(creditCovers(r3, c3sTool) && r3.credit.includes(C3S_CREDIT), `a tool row carries its own source's whole credit, not the family's shorter line (${JSON.stringify(r3.credit)})`);
  ok(!creditCovers({ credit: OPEN_METEO_ATTRIBUTION }, c3sTool) && !creditCovers({}, c3sTool), "control: a row carrying only the family's Open-Meteo line, or no credit, does not cover a Copernicus tool");
  const plain = toolRow("GET /api/edgar-filings", { slug: "edgar-filings", name: "E", price: "$0.005", description: "Filings." }, { baseUrl: "https://x.test", outcome: undefined, available: true, familyCredit: "Source: SEC EDGAR." });
  ok(plain.credit === "Source: SEC EDGAR." && toolRow("GET /api/w", { slug: "weather-alerts", name: "W", price: "$0.001", description: "Alerts." }, { baseUrl: "https://x.test", outcome: undefined, available: true }).credit === null,
    "a tool whose source asks for no credit of its own keeps its family's line, or none");
}
const fakeCatalog = {
  "GET /api/a": { slug: "edgar-filings", name: "A", price: "$0.005" },
  "POST /api/b": { slug: "filings-brief", name: "B", price: "$0.027", quoteRange: { minUsd: 0.027, maxUsd: 1.08 } },
  "POST /api/m": { slug: "edgar-search", name: "M", price: "$0.005", modelBacked: true },
  "GET /api/c": { slug: "hash", name: "C", price: "$0.001" },
};
const ctx = { catalog: fakeCatalog, powSlugs: new Set(["hash"]), baseUrl: "https://x.test", outcomes: { ok: true, rows: [{ slug: "edgar-filings", n: 777, ok: 770, serverErrored: 7, p50: 80, p95: 400 }] }, now };
const row = toolRow("POST /api/b", fakeCatalog["POST /api/b"], { baseUrl: "https://x.test", outcome: undefined, available: true });
ok(ROW_KEYS.every((k) => k in row), `a tool row carries every v1 field (${ROW_KEYS.join(", ")})`);
ok(row.price.text === "$0.027" && row.price.usd === 0.027 && row.price.perRequest.maxUsd === 1.08, "the price is the catalog's own, with the per-request range when quoted");
const idx = wholesaleIndex(ctx);
for (const k of ["version", "stability", "pricing", "errorCodes", "reliabilityDefinition", "docs", "asOf", "families", "notOffered"]) ok(k in idx, `the index carries ${k}`);
ok(idx.version === "v1" && /no wholesale discount/.test(idx.pricing), "v1, and the pricing sentence says no discount");
ok(!/license|vendor/i.test(idx.notOffered) && /^Market data, search results and model output are not offered/.test(idx.notOffered), "notOffered lists what is left out, with no reason given");
const fam = wholesaleFamily("sec-filings", ctx);
ok(fam.tools.map((t) => t.slug).join(",") === "edgar-filings,filings-brief", "a family lists its tools, never a model-backed one");
ok(fam.tools[0].reliability.status === STATUS_MEASURED && fam.tools[0].reliability.successRate === 0.990 && fam.tools[1].reliability.status === STATUS_THIN, "a family row reads its own outcome; a tool with none reads not enough data");
ok(noVolume(fam).length === 0 && noVolume(idx).length === 0 && !JSON.stringify(fam).includes("777"), `no family or index answer carries a count or a band (${noVolume(fam).concat(noVolume(idx)).join(", ") || "none"})`);
const off = wholesaleFamily("sec-filings", { ...ctx, outcomes: { ok: false, reason: "not-configured" } });
ok(off.reliabilityAvailable === false && off.reliabilityReason === "not-configured" && off.tools.every((t) => t.reliability.status === STATUS_THIN), "outcomes that cannot be read: every row not enough data, with the reason");
ok(wholesaleFamily("compute", ctx).tools.map((t) => t.slug).join(",") === "hash", "compute is the proof-of-work set");
{
  // A proof-of-work tool that serves a committed outside dataset, or carries
  // a source's attribution, is not our own computation.
  const cat = { ...fakeCatalog, "GET /api/country-info": { slug: "country-info", name: "Country info", price: "$0.001" }, "GET /api/fx": { slug: "fx-like", name: "F", price: "$0.001", attribution: "ecb" } };
  const c2 = { ...ctx, catalog: cat, powSlugs: new Set(["hash", "country-info", "fx-like"]) };
  ok(wholesaleFamily("compute", c2).tools.map((t) => t.slug).join(",") === "hash" && wholesaleIndex(c2).families.find((f) => f.id === "compute").tools === 1, `the compute family leaves out a dataset tool and an attributed one (${wholesaleFamily("compute", c2).tools.map((t) => t.slug).join(",")})`);
  ok(wholesalePage("https://x.test", cat, c2.powSlugs).includes(">1</td>"), "the page counts the same compute tools as the JSON");
}
{
  // Charged or not on a failure depends on the rail: said once, rail by rail.
  const charging = idx.errorCodes.charging || "";
  ok(idx.errorCodes.refundTerms === `https://x.test${REFUND_TERMS_PATH}`, `the error codes link the refund terms (${idx.errorCodes.refundTerms})`);
  ok(charging === failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"], tempoPush: true }) && charging.includes(TEMPO_PUSH_EXCEPTION), "the contract says which rails a failed call is not charged on, with the Tempo push exception");
  ok(wholesaleIndex({ ...ctx, tempoPush: false }).errorCodes.charging === failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"] }), "with no Tempo push offered the exception is left out");
  ok(JSON.stringify(wholesaleFamily("sec-filings", ctx).errorCodes) === JSON.stringify(idx.errorCodes), "a family answer carries the same error-code contract");
  const page = stripScripts(wholesalePage("https://x.test"), "");
  ok(page.includes(failedCallFootnote({ rails: ["x402", "MPP", "a prepaid credits key"], tempoPush: true })) && !/never charged/i.test(page) && page.includes(REFUND_TERMS_PATH), "the page says it the same way, names the refund terms, and never says an error answer is never charged");
  ok(!stripScripts(wholesalePage("https://x.test", {}, new Set(), { tempoPush: false }), "").includes(TEMPO_PUSH_EXCEPTION), "the page leaves out the exception where Tempo push is not offered");
}
{
  // The contract's own words on where errorCode rides, in the JSON and on the page.
  const note = idx.errorCodes?.note || "";
  ok(note.includes(SCOPE) && note.includes(NOT_CARRIED) && !/every tool error answer/i.test(note), `the JSON's errorCode note is the scoped claim (${JSON.stringify(note.slice(0, 120))})`);
  const pageText = stripScripts(wholesalePage("https://x.test"), "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  ok(typeof SCOPE === "string" && pageText.includes(SCOPE) && pageText.includes(NOT_CARRIED) && !/every tool error answer/i.test(pageText), "the page states the same scoped claim and the 402 exception");
  // Credit: each tool's own line, never one family line for every answer.
  ok(/\beach tool's credit line\b/i.test(pageText) && !/Keep the family's credit line/i.test(pageText), "the page asks for each tool's credit line, not one family line");
}
ok(wholesaleFamily("nope", ctx) === null, "an unknown family reads null");
ok(WHOLESALE_FAMILIES.every((f) => ["public-domain", "cc-by-4.0", "own-computation"].includes(f.redistribution)), "every family's basis is public domain, CC BY 4.0 or our own computation");

// ---- the per-tool table withdrawn: nothing here points to it
{
  const sw = (v) => ({ TOOL_RELIABILITY_PUBLIC: v });
  ok([undefined, "", "on", "1", "true", "yes", "offf"].every((v) => toolReliabilityEnabled(sw(v))), "TOOL_RELIABILITY_PUBLIC unset or any other word: the table is published");
  ok(["off", "0", "false", "no", " OFF ", "False", "NO\n"].every((v) => !toolReliabilityEnabled(sw(v))), "off, 0, false and no (trimmed, any case) withdraw it");
  ok(reliabilityDefinition({}).sameAs === TOOL_RELIABILITY_PATH && !("sameAs" in reliabilityDefinition(sw("off"))) && Object.keys(reliabilityDefinition(sw("off"))).join() === Object.keys(RELIABILITY_DEFINITION).filter((k) => k !== "sameAs").join(), "the definition names the table only while it is published; its other fields stay");
  const surfaces = () => ({
    index: JSON.stringify(wholesaleIndex(ctx)),
    family: JSON.stringify(wholesaleFamily(WHOLESALE_FAMILIES[0].id, ctx)),
    page: wholesalePage("https://agent402.tools"),
    report: JSON.stringify(reliabilityReport({ baseUrl: "https://agent402.tools", network: "base", wallet: null, stats: {} })),
  });
  const before = process.env.TOOL_RELIABILITY_PUBLIC;
  try {
    delete process.env.TOOL_RELIABILITY_PUBLIC;
    const onNow = surfaces();
    ok(Object.entries(onNow).every(([, text]) => text.includes(TOOL_RELIABILITY_PATH)), "published: the wholesale index, a family, the page and /api/reliability each point to it");
    for (const word of ["off", "0", "false", "No"]) {
      process.env.TOOL_RELIABILITY_PUBLIC = word;
      const offNow = surfaces();
      const still = Object.entries(offNow).filter(([, text]) => text.includes(TOOL_RELIABILITY_PATH)).map(([k]) => k);
      ok(still.length === 0, `TOOL_RELIABILITY_PUBLIC=${word}: none of them names the table${still.length ? ` (still: ${still.join(", ")})` : ""}`);
      ok(JSON.parse(offNow.report).endpoints.status && offNow.page.includes("/api/reliability\"") && JSON.parse(offNow.index).reliabilityDefinition.successRate, "the service-wide pointers and the definition's own words stay");
    }
  } finally {
    if (before === undefined) delete process.env.TOOL_RELIABILITY_PUBLIC; else process.env.TOOL_RELIABILITY_PUBLIC = before;
  }
}

// ---- the changelog announces the surface, in both files (CHANGELOG.md and
// the /changelog page, src/changelog.js): the page, the versioned JSON, every
// family by its title, and the errorCode field, claimed exactly where it is
// served: every error answer a tool's route writes other than a 402, which
// follows the x402 and MPP wire formats and carries none.
{
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
  const page = CHANGELOG_ENTRIES.flatMap((e) => e.items || []).join("\n");
  for (const [label, text] of [["CHANGELOG.md", md], ["src/changelog.js", page]]) {
    const lower = text.toLowerCase();
    ok(text.includes("`/wholesale`") && text.includes("`GET /api/wholesale/v1`") && text.includes("`GET /api/wholesale/v1/<family>`"), `${label} announces /wholesale and the versioned JSON`);
    const missing = WHOLESALE_FAMILIES.filter((f) => !lower.includes(f.title.toLowerCase())).map((f) => f.id);
    ok(missing.length === 0, `${label} names every family by its title${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    ok(/`errorCode`/.test(text) && ["invalid_input", "upstream_error"].every((c) => text.includes(`\`${c}\``)), `${label} announces the errorCode field on tool error answers`);
    ok(/other than a 402/.test(text) && /\b402\b[^.]*x402 and MPP wire formats and carries no `?errorCode`?/.test(text), `${label} claims errorCode only where it is served, and says the 402 carries none`);
  }
  // A dated entry is a record of what shipped that day and is never rewritten:
  // the 2026-11-18 announcement keeps its words, and the scoped claim (with
  // the 402 row kept, carried: false) is its own later entry. No entry from
  // 2026-11-20 on makes the unscoped claim.
  const mdGroups = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\n(?=### \d{4}-\d{2}-\d{2})/).map((g) => ({ date: (/^### (\d{4}-\d{2}-\d{2})/.exec(g) || [])[1] || "", text: g.replace(/\s+/g, " ") }));
  for (const [label, groups] of [["CHANGELOG.md", mdGroups], ["src/changelog.js", CHANGELOG_ENTRIES.map((e) => ({ date: e.date, text: (e.items || []).join("\n") }))]]) {
    const late = groups.filter((g) => g.date >= "2026-11-20");
    ok(late.every((g) => !/every tool error answer carries/i.test(g.text)) && late.some((g) => /`payment_required`/.test(g.text) && /`carried: false`/.test(g.text) && /other than a 402/.test(g.text)), `${label}: the 2026-11-20 entry scopes errorCode and names the kept 402 row; no later entry makes the unscoped claim`);
    ok(groups.some((g) => g.date === "2026-11-18" && /Every tool error answer carries `errorCode`/.test(g.text) && /A code is only ever added, never renamed or removed/.test(g.text)), `${label}: the 2026-11-18 entry keeps the words it shipped with`);
  }
}

// ---- a FREE_MODE boot. Outbound fetches are held to loopback: the sweep
// below calls every catalog route, and none of it may reach an upstream.
const PRELOAD = ["--import", "./scripts/lib/loopback-only-preload.js"];
const QUIET = { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", POSTHOG_API_KEY: "", STATS_ALLOW_EPHEMERAL: "true", SOLANA_LEADERBOARD: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000", KALSHI_TOOLS: "", STOCK_DATA_PROVIDER: "", DATABENTO_API_KEY: "", RUGCHECK_TOOLS: "", TRANSCRIBE_LONG: "" };
// A JSON answer's errorCode against its final status: a 402 carries none, any
// other error answer carries the table's code for its status.
const readAnswer = async (res) => { const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: res.status, json }; };
const codeRight = (a) => a.status === 402 ? !(a.json && typeof a.json === "object" && "errorCode" in a.json) : a.json?.errorCode === stableErrorCode(a.status);
let srv = null;
try {
  srv = await bootServer({ args: PRELOAD, env: { FREE_MODE: "true", ...QUIET }, stores: "wholesale" });
  const U = srv.url;
  const pricing = await (await fetch(`${U}/api/pricing`)).json();
  const bySlug = new Map((pricing.endpoints || pricing.tools).map((e) => [e.slug, e]));
  // Twenty-five real calls to one compute tool BEFORE its family is first
  // read (a family answer is kept 60 s), then the read must show them.
  const openapi = await (await fetch(`${U}/openapi.json`)).json();
  const probe = [...FREE_TIER_SLUGS].filter((s) => !COMMITTED_DATASET_SLUGS.includes(s)).map((s) => bySlug.get(s)).find((e) => e && e.method === "GET" && (openapi.paths[e.path]?.get?.parameters || []).some((p) => p.example !== undefined));
  const params = (openapi.paths[probe.path].get.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => `${p.name}=${encodeURIComponent(p.example)}`).join("&");
  let good = 0;
  for (let i = 0; i < 25; i++) { const res = await fetch(`${U}${probe.path}?${params}`); if (res.status < 400) good++; await res.arrayBuffer(); }
  ok(good === 25, `${probe.slug}: its own example answered 25 times`);
  const computeIdx = await (await fetch(`${U}/api/wholesale/v1`)).json();
  ok(computeIdx.families.length === WHOLESALE_FAMILIES.length && computeIdx.families.every((f) => f.tools > 0), `the index lists every family with tools (${computeIdx.families.map((f) => `${f.id} ${f.tools}`).join(", ")})`);
  const all = [];
  for (const f of computeIdx.families) {
    const j = await (await fetch(`${U}/api/wholesale/v1/${f.id}`)).json();
    ok(j.version === "v1" && j.family.id === f.id && j.toolCount === j.tools.length && j.toolCount === f.tools, `${f.id}: v1 answer, toolCount matches rows and the index (${j.toolCount})`);
    all.push(...j.tools.map((t) => ({ ...t, family: f.id })));
  }
  const measured = all.find((t) => t.slug === probe.slug);
  // FREE_MODE counts no outcomes (the failure monitor's lane is the paid
  // dispatcher's), so the rate stays null with its reason; timing is counted.
  // A boot with no analytics store reads every row not enough data, with the reason.
  ok(measured && measured.reliability.status === STATUS_THIN && measured.reliability.successRate === null && measured.reliability.p50Ms === null, `${probe.slug}: with no outcome store, not enough data (${JSON.stringify(measured?.reliability)})`);
  ok(all.every((t) => noVolume(t).length === 0), "no served row carries a count or a band");
  ok(all.every((t) => bySlug.get(t.slug)?.price === t.price.text), "every listed price is /api/pricing's own price (no discount, no drift)");
  ok(all.every((t) => t.modelBacked === false && bySlug.get(t.slug)?.modelBacked !== true), "no listed tool is model-backed");
  ok(!all.some((t) => t.family !== "compute" && /coingecko|databento|brave/i.test(bySlug.get(t.slug)?.description || "")), "no vendor-licensed market data or search results outside the compute family");
  ok(!all.some((t) => t.slug === "token-diligence" || t.slug.startsWith("crypto-") || t.slug.startsWith("coin-") || t.slug.startsWith("stock-")), "the CoinGecko-backed and stock tools are not offered");
  ok(all.some((t) => t.slug === "weather-risk-brief" && t.price.perRequest) && all.some((t) => t.slug === "filings-brief" && t.price.perRequest), "the bundle products are listed with their per-request range");
  ok(all.every((t) => t.reliability.successRate === null || (t.reliability.successRate >= 0 && t.reliability.successRate <= 1)), "every rate is null or in [0, 1]");
  {
    // The compute family is ours: no tool whose description names an outside
    // dataset or its license, or ends with a source's attribution sentence.
    const DATASET = /\bODbL\b|Open Database License|\bCC[ -]BY\b|world-countries/i;
    const borrowed = all.filter((t) => t.family === "compute" && (DATASET.test(bySlug.get(t.slug)?.description || "") || ATTRIBUTION_TAILS.some((x) => (bySlug.get(t.slug)?.description || "").includes(x))));
    ok(borrowed.length === 0 && !all.some((t) => t.family === "compute" && t.slug === "country-info") && bySlug.has("country-info"), `no compute-family tool serves an outside dataset; country-info (ODbL) is served but not listed here (${borrowed.map((t) => t.slug).join(", ") || "none"})`);
  }
  {
    // Every row carries its own credit line, covering what its catalog entry
    // says its source requires; a family credit line is one every tool in it keeps.
    const uncovered = all.filter((t) => !creditCovers(t, bySlug.get(t.slug))).map((t) => `${t.slug} (${JSON.stringify(t.credit)})`);
    ok(all.every((t) => "credit" in t) && uncovered.length === 0, `every row in every family carries its catalog credit whole${uncovered.length ? `: ${uncovered.join(", ")}` : ""}`);
    ok(all.filter((t) => catalogCredit(bySlug.get(t.slug))).length >= 10, `the coverage check reads real attributions (${all.filter((t) => catalogCredit(bySlug.get(t.slug))).length} credited rows)`);
    const untrue = computeIdx.families.filter((f) => f.credit && all.some((t) => t.family === f.id && !String(t.credit || "").includes(f.credit))).map((f) => f.id);
    ok(untrue.length === 0, `a family credit line is one every tool in the family keeps (${untrue.join(", ") || "all true"})`);
  }
  const err = await fetch(`${U}/api/edgar-filings`);
  const ej = await err.json();
  ok(err.status === 400 && ej.errorCode === "invalid_input" && typeof ej.error === "string", "a tool error answer carries its errorCode beside the message");
  {
    // Class-wide: every catalog route, called with an empty input, answers a
    // JSON error with the code for its status (the kit dispatcher's, the
    // bespoke content routes' and the memory routes' own refusals alike).
    const routes = (pricing.endpoints || pricing.tools).map((e) => ({ slug: e.slug, method: String(e.method || "GET").toUpperCase(), path: e.path })).filter((r) => r.path);
    const memory = routes.filter((r) => r.path.startsWith("/api/memory")).map((r) => ({ ...r, path: `${r.path}?ns=wholesale` }));
    const queue = [...routes, ...memory];
    const wrong = [];
    let errors = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const r = queue.shift();
        const a = await readAnswer(await fetch(`${U}${r.path}`, { method: r.method, headers: r.method === "GET" ? {} : { "content-type": "application/json" }, body: r.method === "GET" ? undefined : "{}" }));
        if (a.status < 400 || !a.json || typeof a.json !== "object") continue;
        errors++;
        if (!codeRight(a)) wrong.push(`${r.method} ${r.path} ${a.status}`);
      }
    }));
    ok(errors >= 300 && wrong.length === 0, `every catalog route's JSON error answer carries the code for its status (${errors} error answers; wrong: ${wrong.slice(0, 20).join(", ") || "none"})`);
    ok(memory.length >= 10, `the memory routes are swept with a demo namespace too (${memory.length})`);
  }
  {
    // Class-wide: every retired route (a tool, a pack, a pack's prompt, a
    // pairwise converter) answers 410 with errorCode "retired".
    const gone = [
      ...Object.keys(RETIRED_TOOLS).map((s) => ["GET", `/api/${s}`]),
      ...Object.keys(RETIRED_PACKS).map((s) => ["POST", `/api/skill/${s}`]),
      ...Object.keys(RETIRED_PACKS).map((s) => ["GET", `/api/skill-packs/${s}/prompt`]),
      ["GET", "/api/convert/furlongs-to-parsecs"],
    ];
    const wrong = [];
    for (const [method, path] of gone) {
      const a = await readAnswer(await fetch(`${U}${path}`, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }));
      if (a.status !== 410 || a.json?.errorCode !== "retired") wrong.push(`${method} ${path} ${a.status} ${JSON.stringify(a.json?.errorCode)}`);
    }
    ok(gone.length >= 100 && wrong.length === 0, `every retired route answers 410 with errorCode "retired" (${gone.length} routes; wrong: ${wrong.slice(0, 12).join(", ") || "none"})`);
    // Class-wide: every switched-off tool answers 503 with errorCode "unavailable".
    const off = [...[...KALSHI_SLUGS].map((s) => `/api/${s}`), ...[...STOCK_SLUGS].map((s) => `/api/${s}`), ...[...STOCK_CORE_PACK_SLUGS].map((s) => `/api/skill/${s}`)];
    const wrongOff = [];
    for (const path of off) {
      const a = await readAnswer(await fetch(`${U}${path}`));
      if (a.status !== 503 || a.json?.error !== "not-offered" || a.json?.errorCode !== "unavailable") wrongOff.push(`${path} ${a.status} ${JSON.stringify(a.json?.errorCode)}`);
    }
    ok(off.length >= 6 && wrongOff.length === 0, `every switched-off tool answers its not-offered 503 with errorCode "unavailable" (${off.length} routes; wrong: ${wrongOff.join(", ") || "none"})`);
    // A tool switched off by not mounting its route (RugCheck unset, the long
    // transcription tier without TRANSCRIBE_LONG) answers the /api 404, and
    // a body the parser refuses answers 400 or 413: each carries the code for
    // its status, as the contract says.
    const unmounted = [];
    for (const path of ["/api/sol-token-safety", "/api/transcribe-long", "/api/no-such-tool-zz"]) {
      const a = await readAnswer(await fetch(`${U}${path}`));
      if (a.status !== 404 || a.json?.errorCode !== "not_found") unmounted.push(`${path} ${a.status} ${JSON.stringify(a.json?.errorCode)}`);
    }
    ok(unmounted.length === 0, `a tool whose route is not served, and any unknown /api path, answers 404 with errorCode "not_found" (wrong: ${unmounted.join(", ") || "none"})`);
    const unreadable = await readAnswer(await fetch(`${U}/api/json-format`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    ok(unreadable.status === 400 && unreadable.json?.errorCode === "invalid_input", `a body the server cannot read answers 400 with errorCode "invalid_input" (${unreadable.status} ${JSON.stringify(unreadable.json?.errorCode)})`);
    const tooBig = await readAnswer(await fetch(`${U}/api/json-format`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: "x".repeat(300_000) }) }));
    ok(tooBig.status === 413 && tooBig.json?.errorCode === "input_too_large", `a body over the size limit answers 413 with errorCode "input_too_large" (${tooBig.status} ${JSON.stringify(tooBig.json?.errorCode)})`);
    // The published sentences against what this boot just answered: each
    // kind of answer seen carrying errorCode is named, with its status, in
    // the scope sentence and in no clause of the not-carried one, and every
    // status the scope sentence names is one seen carrying it here.
    const seen = [
      { status: 400, words: /cannot read/, carried: unreadable.status === 400 && unreadable.json?.errorCode === stableErrorCode(400) },
      { status: 413, words: /size limit/, carried: tooBig.status === 413 && tooBig.json?.errorCode === stableErrorCode(413) },
      { status: 404, words: /not served/, carried: unmounted.length === 0 },
      { status: 410, words: /retired route/, carried: wrong.length === 0 },
      { status: 503, words: /switched off/, carried: wrongOff.length === 0 },
    ];
    const names = (text, st) => new RegExp(`\\(${st}\\)|answers ${st}\\b`).test(text);
    const unnamed = seen.filter((x) => x.carried && !(names(SCOPE, x.status) && x.words.test(SCOPE))).map((x) => x.status);
    const denied = seen.filter((x) => x.carried && (x.words.test(NOT_CARRIED) || new RegExp(`\\b${x.status}\\b`).test(NOT_CARRIED))).map((x) => x.status);
    const claimed = [...SCOPE.matchAll(/\((\d{3})\)|answers (\d{3})\b/g)].map((m) => Number(m[1] || m[2]));
    const unseen = claimed.filter((st) => !seen.some((x) => x.status === st && x.carried));
    ok(unnamed.length === 0 && denied.length === 0 && unseen.length === 0 && claimed.length >= seen.length, `the contract's sentences match the answers this boot carries errorCode on (not in the scope: ${unnamed.join(", ") || "none"}; in the not-carried sentence: ${denied.join(", ") || "none"}; claimed but not seen: ${unseen.join(", ") || "none"})`);
  }
  {
    // The compute family is our own computation: no tool that serves this
    // server's read of other sellers (their listings, revenue and settlement
    // counts, a trust verdict on one), and its source line names none.
    const compute = all.filter((t) => t.family === "compute").map((t) => t.slug);
    ok(!compute.includes("x402-market-pulse") && !compute.includes("seller-trust") && bySlug.has("x402-market-pulse") && bySlug.has("seller-trust"), `the compute family leaves out the tools that serve data about other sellers; both are still served (${["x402-market-pulse", "seller-trust"].filter((s) => compute.includes(s)).join(", ") || "none listed"})`);
    ok(!/sellers?'? own|listings/i.test(computeIdx.families.find((f) => f.id === "compute")?.source || ""), `the compute family's source names no seller data (${computeIdx.families.find((f) => f.id === "compute")?.source})`);
    // Every weather row whose tool takes a place name answers GeoNames place
    // data, so its credit names GeoNames; the family's source names each source.
    const takesPlace = (t) => (openapi.paths[t.path]?.get?.parameters || []).some((p) => p.name === "place") || Object.values(openapi.paths[t.path]?.post?.requestBody?.content || {}).some((c) => c?.schema?.properties?.place);
    const placeRows = all.filter((t) => t.family === "weather" && takesPlace(t));
    const noGeo = placeRows.filter((t) => !/GeoNames/.test(t.credit || "")).map((t) => t.slug);
    ok(placeRows.length >= 6 && noGeo.length === 0, `every weather row that takes a place name credits GeoNames (${placeRows.length} rows; missing: ${noGeo.join(", ") || "none"})`);
    const wsrc = computeIdx.families.find((f) => f.id === "weather")?.source || "";
    ok(/Copernicus/.test(wsrc) && /GeoNames/.test(wsrc) && /Open-Meteo/.test(wsrc) && /National Weather Service/.test(wsrc), `the weather family's source names Open-Meteo, Copernicus, GeoNames and the National Weather Service (${wsrc})`);
  }
  const nf = await fetch(`${U}/api/wholesale/v1/nope`);
  const nj = await nf.json();
  ok(nf.status === 404 && nj.errorCode === "not_found" && nj.families.length === WHOLESALE_FAMILIES.length, "an unknown family is a 404 with the code and the family list");
  const page = await fetch(`${U}/wholesale`);
  const html = await page.text();
  ok(page.status === 200 && WHOLESALE_FAMILIES.every((f) => html.includes(`/api/wholesale/v1/${f.id}`)) && ERROR_CODES.every((e) => html.includes(e.code)), "the page renders every family and every error code");
  {
    const fam = await (await fetch(`${U}/api/wholesale/v1/sec-filings`)).json();
    const charging = computeIdx.errorCodes?.charging || "";
    ok(charging.startsWith("A paid call that ends in any status of 400 or above is not charged over x402") && fam.errorCodes?.charging === charging && stripScripts(html, "").includes(`${charging} The refund terms`) && String(computeIdx.errorCodes.refundTerms).endsWith(REFUND_TERMS_PATH), `the served index, a served family and the page state the same rail-scoped sentence and link the refund terms (Tempo push exception ${charging.includes(TEMPO_PUSH_EXCEPTION) ? "included" : "left out"})`);
  }
  ok(!/\$\d/.test(stripScripts(html, "")), "the page types no price");
  const sitemap = await (await fetch(`${U}/sitemap.xml`)).text();
  ok(/\/wholesale</.test(sitemap) || /sitemap-pages/.test(sitemap), "the page is in the sitemap");
} catch (e) {
  ok(false, `boot: ${e?.message || e}`);
} finally {
  await srv?.stop().catch(() => {});
}

// ---- a paid boot (x402 exact on Base, stub facilitator): the payment-required
// answer is the wire format, unchanged, with no errorCode, and the contract
// that boot serves says so instead of listing a code for it.
let paid = null, facilitator = null;
try {
  facilitator = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
      return reply(200, { isValid: false, invalidReason: "stub", success: false });
    });
  });
  await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
  const STUB = `http://127.0.0.1:${facilitator.address().port}`;
  paid = await bootServer({ args: PRELOAD, stores: "wholesale-paid", env: {
    ...QUIET, FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: STUB, AGENT402_BASE_RPC: `${STUB}/rpc`, PAYMENT_SETTLE_FALLBACK: "", FACILITATOR_GAS_CHECK: "off",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "",
    STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", REDIS_URL: "", STATE_DATABASE_URL: "", DATABASE_URL: "", ANALYTICS_DATABASE_URL: "", NODE_ENV: "test",
  } });
  const r = await fetch(`${paid.url}/api/edgar-filings?ticker=AAPL`);
  const a = await readAnswer(r);
  ok(a.status === 402 && r.headers.get("payment-required") && codeRight(a), `an unpaid call to a wholesale tool is the 402 payment challenge with no errorCode (${a.status}, body keys ${a.json && typeof a.json === "object" ? Object.keys(a.json).join(",") || "none" : typeof a.json})`);
  const contract = (await (await fetch(`${paid.url}/api/wholesale/v1`)).json()).errorCodes || {};
  ok((contract.codes || []).find((c) => c.status === 402)?.carried === false && String(contract.note || "").includes(NOT_CARRIED), `the contract that boot serves keeps the 402 row marked not carried and says why (${JSON.stringify((contract.codes || []).find((c) => c.status === 402) || "no 402 row")})`);
} catch (e) {
  ok(false, `paid boot: ${e?.message || e}`);
} finally {
  await paid?.stop().catch(() => {});
  facilitator?.close();
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
